import { get, run } from '../db/index.ts'
import { decrypt, encrypt } from '../lib/crypto.ts'
import { badGateway, unauthorized } from '../lib/errors.ts'
import { log } from '../lib/logger.ts'
import { googleOAuth } from './settings.ts'
import { GoogleProvider } from '../providers/google.ts'
import type { AccountRow } from './accounts.ts'

/**
 * Access-token cache with single-flight refresh.
 *
 * Ten parallel uploads to the same account must produce exactly one token
 * refresh, not ten. The promise map collapses concurrent refreshes and the
 * result is cached in memory so we do not hit the database or Google on every
 * request.
 */

type Cached = { token: string; expiresAt: number }

const tokens = new Map<string, Cached>()
const refreshing = new Map<string, Promise<string>>()

function remember(accountId: string, token: string, expiresAt: number): string {
  tokens.set(accountId, { token, expiresAt })
  return token
}

async function exchangeRefreshToken(account: AccountRow): Promise<string> {
  const creds = googleOAuth()
  if (!creds) throw badGateway('Google OAuth credentials are not configured.')

  const refreshToken = decrypt(account.refresh_token)
  if (!refreshToken) throw unauthorized('This Google account needs to be reconnected.')

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }

  if (!res.ok || !data.access_token) {
    const message = data.error_description || data.error || 'Token refresh failed'
    run('update accounts set status = ?, last_error = ?, updated_at = ? where id = ?', 'error', message, Date.now(), account.id)
    throw unauthorized(`Google token refresh failed: ${message}`)
  }

  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000
  run(
    'update accounts set access_token = ?, token_expires_at = ?, status = ?, last_error = NULL, updated_at = ? where id = ?',
    encrypt(data.access_token),
    expiresAt,
    'connected',
    Date.now(),
    account.id,
  )
  log.debug('google token refreshed', { account: account.label })
  return remember(account.id, data.access_token, expiresAt)
}

export function accessTokenFor(account: AccountRow): Promise<string> {
  const cached = tokens.get(account.id)
  if (cached && cached.expiresAt - Date.now() > 90_000) return Promise.resolve(cached.token)

  // Stored token is still fresh (e.g. after a restart) — reuse it.
  if (account.access_token && account.token_expires_at && account.token_expires_at - Date.now() > 90_000) {
    return Promise.resolve(remember(account.id, decrypt(account.access_token), account.token_expires_at))
  }

  const pending = refreshing.get(account.id)
  if (pending) return pending

  const promise = exchangeRefreshToken(account).finally(() => refreshing.delete(account.id))
  refreshing.set(account.id, promise)
  return promise
}

/** Resolves (and caches in the account row) the Drive folder that holds uploads. */
export async function appFolderIdFor(account: AccountRow): Promise<string> {
  const config = account.config ? (JSON.parse(account.config) as { appFolderId?: string }) : {}
  if (config.appFolderId) return config.appFolderId

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
}

export function forgetToken(accountId: string): void {
  tokens.delete(accountId)
}

export function getAccountRow(id: string): AccountRow | undefined {
  return get<AccountRow>('select * from accounts where id = ?', id)
}
