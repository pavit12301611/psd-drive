import { get, run } from '../db/index.ts'
import { encrypt, newId } from '../lib/crypto.ts'
import { log } from '../lib/logger.ts'
import { GoogleProvider } from '../providers/google.ts'
import { logActivity } from './activity.ts'
import { forgetToken } from './google-auth.ts'

/**
 * Store (or refresh) a connected Google Drive for a user.
 *
 * Shared by the connect flow and by "Continue with Google", which connects the
 * first Drive automatically the way 9Drive does.
 */

export type GoogleTokens = {
  access_token: string
  refresh_token?: string
  expires_in?: number
  scope?: string
}

export type GoogleProfile = {
  id?: string
  email?: string
  name?: string
  picture?: string
}

export type Inspected = {
  email: string | null
  name: string | null
  quota: { total: number | null; used: number; available: number | null }
}

export type ConnectResult = { accountId: string; isNew: boolean; label: string }

export async function connectGoogleAccount(input: {
  userId: string
  tokens: GoogleTokens
  profile: GoogleProfile
  inspected: Inspected
  fallbackLabel?: string
}): Promise<ConnectResult> {
  const { userId, tokens, profile, inspected } = input
  const providerAccountId = profile.id ?? inspected.email
  if (!providerAccountId) throw new Error('Google profile did not include an id or email address.')

  const existing = get<{ id: string; refresh_token: string | null }>(
    'select id, refresh_token from accounts where user_id = ? and provider = ? and provider_account_id = ?',
    userId,
    'google',
    providerAccountId,
  )

  const label =
    profile.name ?? inspected.name ?? profile.email ?? inspected.email ?? input.fallbackLabel ?? 'Google Drive'
  const email = profile.email ?? inspected.email ?? null
  const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000
  const refreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : (existing?.refresh_token ?? null)
  const scopes =
    tokens.scope ?? 'https://www.googleapis.com/auth/drive openid email profile'
  const now = Date.now()

  let accountId: string
  if (existing) {
    accountId = existing.id
    run(
      `update accounts set access_token = ?, refresh_token = ?, token_expires_at = ?, scopes = ?,
         label = ?, email = ?, avatar_url = ?, total_bytes = ?, used_bytes = ?, available_bytes = ?,
         quota_synced_at = ?, enabled = 1, status = 'connected', last_error = null, updated_at = ?
       where id = ?`,
      encrypt(tokens.access_token),
      refreshToken,
      expiresAt,
      scopes,
      label,
      email,
      profile.picture ?? null,
      inspected.quota.total,
      inspected.quota.used,
      inspected.quota.available,
      now,
      now,
      accountId,
    )
    // The previous folder may belong to a grant that no longer exists.
    run('update accounts set config = null where id = ?', accountId)
  } else {
    accountId = newId()
    const priority = Number(get<{ c: number }>('select count(*) as c from accounts where user_id = ?', userId)?.c ?? 0)
    run(
      `insert into accounts (id, user_id, provider, label, email, avatar_url, provider_account_id,
         access_token, refresh_token, token_expires_at, scopes, config, total_bytes, used_bytes,
         available_bytes, quota_synced_at, priority, enabled, status, created_at, updated_at)
       values (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?, 1, 'connected', ?, ?)`,
      accountId,
      userId,
      label,
      email,
      profile.picture ?? null,
      providerAccountId,
      encrypt(tokens.access_token),
      refreshToken,
      expiresAt,
      scopes,
      inspected.quota.total,
      inspected.quota.used,
      inspected.quota.available,
      now,
      priority,
      now,
      now,
    )
  }

  // A reconnect must not keep serving the token we just replaced.
  forgetToken(accountId)

  // Create the upload folder now so the very first upload does not have to.
  if (get('select id from accounts where id = ?', accountId)) {
    try {
      const folderId = await GoogleProvider.ensureAppFolder(tokens.access_token)
      run('update accounts set config = ? where id = ?', JSON.stringify({ appFolderId: folderId }), accountId)
    } catch (err) {
      // Not fatal: the folder is created lazily on the first upload.
      log.warn('could not pre-create the PSDrive folder', { error: (err as Error).message })
    }
  }

  logActivity({
    userId,
    action: existing ? 'account.reconnected' : 'account.connected',
    entityType: 'account',
    entityId: accountId,
    entityName: email ?? label,
    meta: { provider: 'google', total: inspected.quota.total },
  })

  log.info('google account connected', { email, quotaTotal: inspected.quota.total, isNew: !existing })
  return { accountId, isNew: !existing, label }
}
