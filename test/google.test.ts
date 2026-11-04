import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startMockGoogle, type MockGoogle } from './helpers/mock-google.ts'

/**
 * Real Google Drive integration, end to end.
 *
 * The app is booted unmodified; only the Google base URLs point at a mock
 * server that implements the same contracts (OAuth redirect, code exchange,
 * refresh, userinfo, about, resumable upload, alt=media with Range, delete).
 * If this test passes, the production code path works against googleapis.com —
 * what remains is credentials, not code.
 */

const PORT = 4100 + Math.floor(Math.random() * 200)
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(path.join(tmpdir(), 'psdrive-google-'))

let child: ChildProcess
let google: MockGoogle
let token = ''
let accountId = ''
let fileId = ''

const auth = () => ({ authorization: `Bearer ${token}` })

async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`)
      if (res.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  throw new Error('server did not start in time')
}

async function call(pathname: string, init: RequestInit = {}) {
  return fetch(`${BASE}${pathname}`, { ...init, headers: { ...auth(), ...(init.headers ?? {}) } })
}

async function json<T = any>(res: Response): Promise<T> {
  const text = await res.text()
  return text ? (JSON.parse(text) as T) : ({} as T)
}

before(async () => {
  google = await startMockGoogle()

  child = spawn(process.execPath, ['src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...google.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      DEMO_MODE: 'false',
      LOG_LEVEL: 'error',
      APP_URL: BASE,
    },
    stdio: 'ignore',
  })

  await waitForServer()

  const registered = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Real Owner', email: 'owner@example.com', password: 'correct horse battery' }),
  })
  assert.equal(registered.status, 201)
  token = (await json<{ accessToken: string }>(registered)).accessToken

  const saved = await call('/api/settings/google', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: 'mock-client-id.apps.googleusercontent.com', clientSecret: 'mock-secret' }),
  })
  assert.equal(saved.status, 200, await saved.text())
})

after(async () => {
  child?.kill('SIGTERM')
  await google?.close()
  rmSync(dataDir, { recursive: true, force: true })
})

test('a fresh instance reports itself as needing setup', async () => {
  const res = await fetch(`${BASE}/api/auth/instance`)
  const body = await json<{ needsSetup: boolean; demoMode: boolean; google: { configured: boolean } }>(res)
  assert.equal(body.demoMode, false, 'demo mode must be off unless explicitly enabled')
  assert.equal(body.needsSetup, false, 'the owner account was just created')
  assert.equal(body.google.configured, true)
})

test('demo login is refused when demo mode is off', async () => {
  const res = await fetch(`${BASE}/api/auth/demo`, { method: 'POST' })
  assert.equal(res.status, 401)
})

test('connecting a Google Drive walks the real OAuth flow', async () => {
  const start = await call('/api/oauth/google/url', { method: 'POST' })
  assert.equal(start.status, 200)
  const { url, redirectUri } = await json<{ url: string; redirectUri: string }>(start)

  assert.equal(redirectUri, `${BASE}/api/oauth/google/callback`)

  const nonce = start.headers.getSetCookie().find((cookie) => cookie.startsWith('psd_oauth='))
  assert.ok(nonce, 'the flow must bind the browser with a nonce cookie')
  const cookie = nonce.split(';')[0]

  const consentUrl = new URL(url)
  assert.equal(consentUrl.origin, google.origin, 'consent must be sent to the configured Google auth endpoint')
  assert.equal(consentUrl.searchParams.get('access_type'), 'offline')
  assert.match(consentUrl.searchParams.get('prompt') ?? '', /consent/)
  assert.match(consentUrl.searchParams.get('scope') ?? '', /auth\/drive/)

  // Google answers with a redirect carrying a one-time code.
  const consent = await fetch(url, { redirect: 'manual' })
  assert.equal(consent.status, 302)
  const callbackUrl = consent.headers.get('location')!

  const callback = await fetch(callbackUrl, { headers: { cookie }, redirect: 'manual' })
  assert.equal(callback.status, 302)
  assert.match(callback.headers.get('location') ?? '', /google=connected/)
})

test('the connected account carries real identity and Drive quota', async () => {
  const res = await call('/api/accounts')
  const body = await json<{
    accounts: { id: string; provider: string; email: string; totalBytes: number; usedBytes: number; availableBytes: number; status: string }[]
  }>(res)

  assert.equal(body.accounts.length, 1)
  const [account] = body.accounts
  assert.equal(account.provider, 'google')
  assert.equal(account.email, 'real.person@example.com')
  assert.equal(account.totalBytes, 16_106_127_360)
  assert.equal(account.usedBytes, 1_073_741_824)
  assert.equal(account.availableBytes, 16_106_127_360 - 1_073_741_824)
  assert.equal(account.status, 'connected')
  accountId = account.id
})

test('a filled Drive is reported as 507, not as a mystery failure', async () => {
  google.setQuota(1000, 1000)
  const res = await call('/api/uploads?name=too-big.bin', {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', 'content-length': '5' },
    body: 'hello',
  })
  // Routing already knows the account has 0 bytes free, so it refuses before
  // touching Google at all.
  assert.equal(res.status, 507)

  google.setQuota(16_106_127_360, 1_073_741_824)
  await call('/api/stats/refresh', { method: 'POST' })
  const accounts = await json<{ accounts: { id: string; availableBytes: number }[] }>(await call('/api/accounts'))
  assert.ok(accounts.accounts[0].availableBytes > 0)
})

test('uploads stream to Drive and land in the PSDrive folder', async () => {
  const res = await call('/api/uploads?name=hello.txt', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'content-length': '11' },
    body: 'hello world',
  })

  const body = await json<{ file: { id: string; sizeBytes: number; name: string } }>(res)
  assert.equal(res.status, 201, JSON.stringify(body))
  assert.equal(body.file.name, 'hello.txt')
  assert.equal(body.file.sizeBytes, 11)
  fileId = body.file.id

  const stored = google.files()
  assert.equal(stored.length, 2, 'the PSDrive folder plus the uploaded file')

  const folder = stored.find((file) => file.mimeType === 'application/vnd.google-apps.folder')
  const file = stored.find((entry) => entry.name === 'hello.txt')
  assert.ok(folder, 'the app folder must be created inside Drive')
  assert.equal(folder.name, 'PSDrive')
  assert.deepEqual(file!.parents, [folder.id], 'the upload must live inside PSDrive')
  assert.equal(file!.size, 11)
})

test('downloads are byte exact and support HTTP ranges', async () => {
  const whole = await call(`/api/files/content/${fileId}`)
  assert.equal(whole.status, 200)
  assert.equal(whole.headers.get('accept-ranges'), 'bytes')
  assert.equal(await whole.text(), 'hello world')

  const ranged = await call(`/api/files/content/${fileId}`, { headers: { Range: 'bytes=0-4' } })
  assert.equal(ranged.status, 206)
  assert.equal(ranged.headers.get('content-range'), 'bytes 0-4/11')
  assert.equal(await ranged.text(), 'hello')
})

test('an expired access token triggers a single refresh, not a failure', async () => {
  const before = google.stats().refreshes
  google.expireAccessToken()

  const res = await call(`/api/files/content/${fileId}`)
  assert.equal(res.status, 200, 'the provider must refresh and retry transparently')
  assert.equal(await res.text(), 'hello world')
  assert.equal(google.stats().refreshes, before + 1, 'exactly one refresh for one 401')
})

test('Sync Drive imports files added straight from the Drive web UI', async () => {
  const folder = google.files().find((file) => file.mimeType === 'application/vnd.google-apps.folder')
  assert.ok(folder)
  const externalId = google.addFile(folder.id, 'from-google-drive.txt', 'added in Drive')

  const before = await json<{ total: number }>(await call('/api/files?limit=200'))
  const synced = await call('/api/files/sync', { method: 'POST' })
  assert.equal(synced.status, 200)
  const summary = await json<{ added: number; removed: number }>(synced)
  assert.equal(summary.added, 1)

  const after = await json<{ files: { id: string; name: string; sizeBytes: number }[] }>(await call('/api/files?limit=200'))
  assert.equal(after.total ?? after.files.length, before.total + 1)
  const imported = after.files.find((file) => file.name === 'from-google-drive.txt')
  assert.ok(imported, 'the Drive-side file must appear in the app')
  assert.equal(imported.sizeBytes, 'added in Drive'.length)

  // Renaming in Drive is picked up on the next sync.
  google.renameFile(externalId, 'renamed-in-google.txt')
  await call('/api/files/sync', { method: 'POST' })
  const renamed = await json<{ files: { name: string }[] }>(await call('/api/files?limit=200'))
  assert.ok(renamed.files.some((file) => file.name === 'renamed-in-google.txt'))

  // Deleting in Drive moves it to the app's recycle bin instead of leaving a dead row.
  google.deleteFile(externalId)
  const removedSummary = await json<{ removed: number }>(await call('/api/files/sync', { method: 'POST' }))
  assert.equal(removedSummary.removed, 1)

  const visible = await json<{ files: { name: string }[] }>(await call('/api/files?limit=200'))
  assert.ok(!visible.files.some((file) => file.name === 'renamed-in-google.txt'))
  const trash = await json<{ files: { name: string }[] }>(await call('/api/files?view=trash&limit=200'))
  assert.ok(trash.files.some((file) => file.name === 'renamed-in-google.txt'))
})

test('Continue with Google signs in and auto-connects that Drive', async () => {
  const start = await fetch(`${BASE}/api/oauth/google/login/url?next=/drive`)
  assert.equal(start.status, 200)
  const { url } = await json<{ url: string }>(start)
  const nonceCookie = start.headers.getSetCookie().find((cookie) => cookie.startsWith('psd_oauth='))
  assert.ok(nonceCookie, 'sign-in must bind the browser too')
  const cookie = nonceCookie.split(';')[0]

  const consent = await fetch(url, { redirect: 'manual' })
  const callbackUrl = consent.headers.get('location')!

  const callback = await fetch(callbackUrl, { headers: { cookie }, redirect: 'manual' })
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.get('location'), `${BASE}/drive`)

  const cookies = callback.headers.getSetCookie()
  const refresh = cookies.find((entry) => entry.startsWith('psd_rt='))
  const access = cookies.find((entry) => entry.startsWith('psd_at='))
  assert.ok(refresh && access, 'a full session must be issued')
  assert.match(refresh, /HttpOnly/i)

  // The refresh cookie alone is enough to restore a session on the next load.
  const restored = await fetch(`${BASE}/api/auth/refresh`, {
    method: 'POST',
    headers: { cookie: refresh.split(';')[0] },
  })
  assert.equal(restored.status, 200)
  const session = await json<{ accessToken: string; user: { email: string } }>(restored)
  assert.equal(session.user.email, 'real.person@example.com')

  // …and the Drive was connected as part of signing in.
  const accounts = await json<{ accounts: { provider: string; email: string }[] }>(
    await fetch(`${BASE}/api/accounts`, { headers: { authorization: `Bearer ${session.accessToken}` } }),
  )
  assert.equal(accounts.accounts.length, 1)
  assert.equal(accounts.accounts[0].email, 'real.person@example.com')
})

test('nothing is ever written to the server disk', async () => {
  // The whole point of a gateway: bytes go browser -> server -> Drive without
  // touching local storage.
  assert.equal(existsSync(path.join(dataDir, 'blobs')), false, 'no blob directory may exist')
  const entries = readdirSync(dataDir).sort()
  assert.deepEqual(
    entries.filter((entry) => entry !== 'secret.key'),
    ['psdrive.db', 'psdrive.db-shm', 'psdrive.db-wal'].filter((entry) => entries.includes(entry)),
  )
})

test('renaming and deleting reach Google', async () => {
  const renamed = await call(`/api/files/${fileId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'renamed.txt' }),
  })
  assert.ok(renamed.status < 400)
  assert.ok(google.files().some((file) => file.name === 'renamed.txt'))

  const trashed = await call('/api/files/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: [fileId], action: 'trash' }),
  })
  assert.ok(trashed.status < 400)
})

test('a revoked grant is surfaced as "reconnect", never as a hang', async () => {
  google.expireAccessToken()
  google.revokeGrant()

  const res = await call(`/api/files/content/${fileId}`)
  assert.equal(res.status, 401)
  const body = await json<{ error: { code: string; message: string } }>(res)
  assert.equal(body.error.code, 'GOOGLE_REAUTH')
  assert.match(body.error.message, /reconnect/i)

  const accounts = await json<{ accounts: { status: string; availableBytes: number }[] }>(await call('/api/accounts'))
  const account = accounts.accounts.find((entry) => entry.status === 'reauth_required')
  assert.ok(account, 'the account must be flagged so routing stops using it')
  assert.equal(account.availableBytes, 0)


  const pool = await json<{ pool: { accounts: { status: string; availableBytes: number }[] } }>(await call('/api/stats'))
  assert.equal(pool.pool.accounts[0].status, 'reauth_required')
  assert.equal(pool.pool.accounts[0].availableBytes, 0)
  assert.ok(accountId)
})
