import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Full-stack integration test: boots the real server on a scratch data
 * directory and drives it over HTTP exactly like a browser or a script would.
 */

const PORT = 3800 + Math.floor(Math.random() * 200)
const BASE = `http://127.0.0.1:${PORT}`
const dataDir = mkdtempSync(path.join(tmpdir(), 'psdrive-test-'))

let child: ChildProcess
let token = ''
let fileId = ''
let shareToken = ''
let apiKey = ''

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

const auth = () => ({ authorization: `Bearer ${token}` })

async function post(pathname: string, body?: unknown) {
  return fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function json<T = any>(res: Response): Promise<T> {
  const text = await res.text()
  return text ? (JSON.parse(text) as T) : ({} as T)
}

before(async () => {
  child = spawn(process.execPath, ['src/server.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      DEMO_MODE: 'false',
      LOG_LEVEL: 'error',
      APP_SECRET: 'test-secret-that-is-long-enough-for-aes-256!!',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stderr?.on('data', (chunk) => {
    const text = String(chunk)
    if (!text.includes('ExperimentalWarning')) process.stderr.write(`[server] ${text}`)
  })

  await waitForServer()

  const registered = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Test User', email: 'test@example.com', password: 'supersecret123' }),
  })
  assert.equal(registered.status, 201, 'registration should succeed')
  const session = await json<{ accessToken: string }>(registered)
  token = session.accessToken
  assert.ok(token)
})

after(async () => {
  child?.kill('SIGTERM')
  await new Promise((resolve) => setTimeout(resolve, 300))
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('health check reports database details', async () => {
  const res = await fetch(`${BASE}/healthz`)
  const body = await json(res)
  assert.equal(body.ok, true)
  assert.equal(body.db.version, '3.51.3')
})

test('private endpoints reject anonymous requests', async () => {
  for (const pathname of ['/api/files', '/api/stats', '/api/accounts', '/api/api-keys']) {
    const res = await fetch(`${BASE}${pathname}`)
    assert.equal(res.status, 401, `${pathname} should be protected`)
  }
})

test('a fresh account has no storage and cannot upload', async () => {
  const stats = await json(await fetch(`${BASE}/api/stats`, { headers: auth() }))
  assert.equal(stats.accounts.length, 0)
  assert.equal(stats.pool.accountCount, 0)

  const res = await fetch(`${BASE}/api/uploads?name=x.txt`, {
    method: 'POST',
    headers: { ...auth(), 'content-length': '3' },
    body: 'abc',
  })
  assert.equal(res.status, 409)
  assert.equal((await json(res)).error.code, 'NO_ACCOUNTS')
})

test('local storage can be connected and reports quota', async () => {
  const created = await post('/api/accounts/local', { label: 'Test disk', quotaGb: 0.05 })
  assert.equal(created.status, 201)

  const stats = await json(await fetch(`${BASE}/api/stats`, { headers: auth() }))
  assert.equal(stats.accounts.length, 1)
  assert.equal(stats.accounts[0].label, 'Test disk')
  assert.equal(stats.accounts[0].totalBytes, Math.round(0.05 * 1024 ** 3))
})

test('upload streams, is recorded, and reports the chosen account', async () => {
  const payload = randomBytes(2 * 1024 * 1024)
  const res = await fetch(`${BASE}/api/uploads?name=payload.bin&mime=application/octet-stream`, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    body: payload,
  })

  assert.equal(res.status, 201)
  const body = await json(res)
  assert.equal(body.file.sizeBytes, payload.length)
  assert.equal(body.account.label, 'Test disk')
  fileId = body.file.id

  const stats = await json(await fetch(`${BASE}/api/stats`, { headers: auth() }))
  assert.equal(stats.pool.usedBytes, payload.length)
})

test('range requests return exactly the requested slice', async () => {
  const res = await fetch(`${BASE}/api/files/content/${fileId}`, {
    headers: { ...auth(), range: 'bytes=100-199' },
  })
  assert.equal(res.status, 206)
  assert.equal(res.headers.get('content-range'), `bytes 100-199/${2 * 1024 * 1024}`)
  assert.equal(res.headers.get('accept-ranges'), 'bytes')

  const slice = new Uint8Array(await res.arrayBuffer())
  assert.equal(slice.length, 100)
})

test('an out-of-bounds range is a 416', async () => {
  const res = await fetch(`${BASE}/api/files/content/${fileId}`, {
    headers: { ...auth(), range: 'bytes=99999999-' },
  })
  assert.equal(res.status, 416)
  assert.equal(res.headers.get('content-range'), `bytes */${2 * 1024 * 1024}`)
})

test('full-text search finds uploaded files', async () => {
  const res = await fetch(`${BASE}/api/files?q=payl`, { headers: auth() })
  const body = await json(res)
  assert.equal(body.total, 1)
  assert.equal(body.files[0].name, 'payload.bin')

  const miss = await json(await fetch(`${BASE}/api/files?q=nothingmatchesthis`, { headers: auth() }))
  assert.equal(miss.total, 0)
})

test('public share links work without a session', async () => {
  const created = await post('/api/shares', { fileId })
  assert.equal(created.status, 201)
  const share = (await json(created)).share
  shareToken = share.token

  const meta = await fetch(`${BASE}/api/public/${shareToken}`)
  assert.equal(meta.status, 200)
  const metaBody = await json(meta)
  assert.equal(metaBody.share.fileName, 'payload.bin')
  assert.equal(metaBody.share.sizeBytes, 2 * 1024 * 1024)

  const download = await fetch(`${BASE}/api/public/${shareToken}/download`)
  assert.equal(download.status, 200)
  const bytes = new Uint8Array(await download.arrayBuffer())
  assert.equal(bytes.length, 2 * 1024 * 1024)

  const bogus = await fetch(`${BASE}/api/public/not-a-real-token`)
  assert.equal(bogus.status, 404)
})

test('revoking a share kills the link', async () => {
  const shares = await json(await fetch(`${BASE}/api/shares`, { headers: auth() }))
  assert.equal(shares.shares.length, 1)

  const revoke = await fetch(`${BASE}/api/shares/${shares.shares[0].id}`, { method: 'DELETE', headers: auth() })
  assert.equal(revoke.status, 200)

  const after = await fetch(`${BASE}/api/public/${shareToken}`)
  assert.equal(after.status, 404)
})

test('API keys authorise the machine API and are scoped', async () => {
  const created = await post('/api/api-keys', { name: 'CI', scopes: ['read'] })
  apiKey = (await json(created)).key.secret
  assert.match(apiKey, /^psd_/)

  const usage = await fetch(`${BASE}/api/v1/usage`, { headers: { 'x-api-key': apiKey } })
  assert.equal(usage.status, 200)

  // A read-only key must not be able to upload.
  const denied = await fetch(`${BASE}/api/v1/files?name=nope.txt`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'content-length': '2' },
    body: 'hi',
  })
  assert.equal(denied.status, 401)

  const badKey = await fetch(`${BASE}/api/v1/usage`, { headers: { 'x-api-key': 'psd_wrong' } })
  assert.equal(badKey.status, 401)
})

test('uploads route away from accounts that are full', async () => {
  // Add a nearly-full account (10 MB quota, 9 MB already used).
  await post('/api/accounts/local', { label: 'Small disk', quotaGb: 0.01 })
  const filler = randomBytes(9 * 1024 * 1024)
  const res = await fetch(`${BASE}/api/uploads?name=filler.bin`, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    body: filler,
  })
  const body = await json(res)
  // "Test disk" has ~53 MB free minus 2 MB, "Small disk" has ~10 MB.
  assert.equal(body.account.label, 'Test disk')

  // Nothing can hold 80 MB: the pool is 53 + 10 MB total.
  const huge = Buffer.alloc(80 * 1024 * 1024)
  const rejected = await fetch(`${BASE}/api/uploads?name=huge.bin`, {
    method: 'POST',
    headers: { ...auth(), 'content-type': 'application/octet-stream' },
    body: huge,
  })
  assert.equal(rejected.status, 507)
  assert.equal((await json(rejected)).error.code, 'STORAGE_FULL')
})

test('validation errors are structured and readable', async () => {
  const res = await post('/api/accounts/local', { label: '' })
  assert.equal(res.status, 400)
  const body = await json(res)
  assert.equal(body.error.code, 'VALIDATION_ERROR')
  assert.ok(body.error.details.length > 0)
})

test('folders can be nested, renamed, and deleted', async () => {
  const parent = await json(await post('/api/folders', { name: 'Parent' }))
  const child = await json(await post('/api/folders', { name: 'Child', parentId: parent.folder.id }))
  assert.equal(child.folder.parentId, parent.folder.id)

  const moved = await fetch(`${BASE}/api/folders/${child.folder.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...auth() },
    body: JSON.stringify({ parentId: child.folder.id }),
  })
  assert.equal(moved.status, 400, 'a folder cannot be moved inside itself')

  const tree = await json(await fetch(`${BASE}/api/folders/tree`, { headers: auth() }))
  assert.equal(tree.folders.length, 2)

  const deleted = await fetch(`${BASE}/api/folders/${parent.folder.id}`, { method: 'DELETE', headers: auth() })
  assert.equal(deleted.status, 200)
})

test('trash, restore and purge behave like a real file manager', async () => {
  const trashed = await post('/api/files/bulk', { ids: [fileId], action: 'trash' })
  assert.equal((await json(trashed)).affected, 1)

  const trashView = await json(await fetch(`${BASE}/api/files?view=trash`, { headers: auth() }))
  assert.equal(trashView.total, 1)

  const restored = await post('/api/files/bulk', { ids: [fileId], action: 'restore' })
  assert.equal((await json(restored)).affected, 1)

  const purged = await post('/api/files/bulk', { ids: [fileId], action: 'purge' })
  assert.equal((await json(purged)).affected, 1)

  const gone = await fetch(`${BASE}/api/files/${fileId}`, { headers: auth() })
  assert.equal(gone.status, 404)
})

test('sessions rotate: refresh issues a new token and logs the old one out', async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'supersecret123' }),
  })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'a refresh cookie should be set')

  const refreshed = await fetch(`${BASE}/api/auth/refresh`, { method: 'POST', headers: { cookie: cookie! } })
  assert.equal(refreshed.status, 200)
  const next = await json<{ accessToken: string }>(refreshed)
  assert.ok(next.accessToken)

  // The original refresh token is burned by rotation.
  const replay = await fetch(`${BASE}/api/auth/refresh`, { method: 'POST', headers: { cookie: cookie! } })
  assert.equal(replay.status, 401)
})

test('wrong passwords are rejected', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'not-the-password' }),
  })
  assert.equal(res.status, 401)
})

test('media and downloads authenticate by cookie, mutations do not', async () => {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'test@example.com', password: 'supersecret123' }),
  })
  const cookies = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ')
  assert.ok(cookies.includes('psd_at'), 'an access cookie should be issued for media requests')

  // Safe method: the cookie alone is enough (this is what <img src> sends).
  const media = await fetch(`${BASE}/api/files`, { headers: { cookie: cookies } })
  assert.equal(media.status, 200)

  // Unsafe method: a cookie must never authorise a change (CSRF guard).
  const mutation = await fetch(`${BASE}/api/folders`, {
    method: 'POST',
    headers: { cookie: cookies, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'CSRF attempt' }),
  })
  assert.equal(mutation.status, 401)
})
