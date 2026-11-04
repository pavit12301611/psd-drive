import { config } from '../config.ts'
import { get, run } from '../db/index.ts'
import { decrypt, encrypt } from '../lib/crypto.ts'
import { HttpError, badGateway } from '../lib/errors.ts'
import { log } from '../lib/logger.ts'
import { googleOAuth } from './settings.ts'
import { GoogleProvider, type AccountProblem } from '../providers/google.ts'
import type { AccountRow } from './accounts.ts'

/**
 * Access-token cache with single-flight refresh.
 *
 * Ten parallel uploads to the same account must produce exactly one token
 * refresh, not ten. The promise map collapses concurrent refreshes and the
 * result is cached in memory so we do not hit the database or Google on every
 * request.
 *
 * `accessTokenFor(account, { force: true })` bypasses the cache — that is what
 * the provider calls after Google answers 401, which is the one case where the
 * cached token is known to be wrong.
 */

type Cached = { token: string; expiresAt: number }

const tokens = new Map<string, Cached>()
const refreshing = new Map<string, Promise<string>>()
const folderLookups = new Map<string, Promise<string>>()

/** Refresh a little early so a token cannot expire mid-request. */
const EARLY_REFRESH_MS = 120_000

function remember(accountId: string, token: string, expiresAt: number): string {
  tokens.set(accountId, { token, expiresAt })
  return token
}

/** Persist that this account needs the user's attention, and take it out of rotation. */
export function markAccountProblem(accountId: string, problem: AccountProblem): void {
  tokens.delete(accountId)
  const now = Date.now()
  // Zeroing `available_bytes` is what actually stops the router from picking
  // this account again — `enabled` stays 1 so the user still sees it and can
  // reconnect or free space.
  run(
    `update accounts set status = ?, last_error = ?, available_bytes = 0, quota_synced_at = ?, updated_at = ?
     where id = ?`,
    problem.kind === 'reauth' ? 'reauth_required' : 'full',
    problem.message.slice(0, 300),
    now,
    now,
    accountId,
  )

  log.warn('google account problem', { accountId, kind: problem.kind, message: problem.message })
}

async function exchangeRefreshToken(account: AccountRow): Promise<string> {
  const creds = googleOAuth()
  if (!creds) throw badGateway('Google OAuth credentials are not configured.')

  const refreshToken = decrypt(account.refresh_token)
  if (!refreshToken) {
    markAccountProblem(account.id, {
      kind: 'reauth',
      message: 'No refresh token stored for this account. Reconnect it to renew access.',
    })
    throw new HttpError(
      401,
      'GOOGLE_REAUTH',
      'This Google account needs to be reconnected from the Storage page.',
    )
  }

  let res: Response
  try {
    res = await fetch(config.google.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (err) {
    throw badGateway(`Could not reach Google to refresh the access token: ${(err as Error).message}`)
  }

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }

  if (!res.ok || !data.access_token) {
    const raw = data.error_description || data.error || 'Token refresh failed'

    // invalid_grant means the user removed access, changed their password or
    // revoked the app — no amount of retrying will help, so we stop routing
    // uploads to this account and ask for a reconnect.
    if (data.error === 'invalid_grant') {
      markAccountProblem(account.id, {
        kind: 'reauth',
        message: 'Google revoked access to this account. Reconnect it to continue syncing.',
      })
      throw new HttpError(
        401,
        'GOOGLE_REAUTH',
        'Google revoked access to this account. Reconnect it from the Storage page.',
      )
    }

    if (data.error === 'invalid_client' || data.error === 'unauthorized_client') {
      throw new HttpError(
        400,
        'GOOGLE_CLIENT_INVALID',
        'Google rejected the OAuth client credentials. Check the client ID and secret in Settings → Google.',
      )
    }

    run('update accounts set last_error = ?, updated_at = ? where id = ?', raw.slice(0, 300), Date.now(), account.id)
    throw badGateway(`Google token refresh failed: ${raw}`)
  }

  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000
  run(
    `update accounts set access_token = ?, token_expires_at = ?,
       status = case when status = 'reauth_required' then 'connected' else status end,
       last_error = null, updated_at = ? where id = ?`,
    encrypt(data.access_token),
    expiresAt,
    Date.now(),
    account.id,
  )
  log.debug('google token refreshed', { account: account.label })
  return remember(account.id, data.access_token, expiresAt)
}

export function accessTokenFor(account: AccountRow, options: { force?: boolean } = {}): Promise<string> {
  if (options.force) {
    tokens.delete(account.id)
  } else {
    const cached = tokens.get(account.id)
    if (cached && cached.expiresAt - Date.now() > EARLY_REFRESH_MS) return Promise.resolve(cached.token)

    // Stored token is still fresh (e.g. right after a restart) — reuse it.
    if (account.access_token && account.token_expires_at && account.token_expires_at - Date.now() > EARLY_REFRESH_MS) {
      return Promise.resolve(remember(account.id, decrypt(account.access_token), account.token_expires_at))
    }
  }

  const pending = refreshing.get(account.id)
  if (pending) return pending

  const promise = exchangeRefreshToken(account).finally(() => refreshing.delete(account.id))
  refreshing.set(account.id, promise)
  return promise
}

/**
 * Resolves (and caches in the account row) the Drive folder that holds uploads.
 *
 * Single-flight: two parallel uploads on a brand-new account must create one
 * folder in Drive, not two.
 */
export function appFolderIdFor(account: AccountRow): Promise<string> {
  const config = account.config ? (JSON.parse(account.config) as { appFolderId?: string }) : {}
  if (config.appFolderId) return Promise.resolve(config.appFolderId)

  const pending = folderLookups.get(account.id)
  if (pending) return pending

  const promise = (async () => {
    const token = await accessTokenFor(account)
    const folderId = await GoogleProvider.ensureAppFolder(token)
    run(
      'update accounts set config = ?, updated_at = ? where id = ?',
      JSON.stringify({ ...config, appFolderId: folderId }),
      Date.now(),
      account.id,
    )
    account.config = JSON.stringify({ ...config, appFolderId: folderId })
    return folderId
  })().finally(() => folderLookups.delete(account.id))

  folderLookups.set(account.id, promise)
  return promise
}

export function forgetToken(accountId: string): void {
  tokens.delete(accountId)
  folderLookups.delete(accountId)
}

export function getAccountRow(id: string): AccountRow | undefined {
  return get<AccountRow>('select * from accounts where id = ?', id)
}
