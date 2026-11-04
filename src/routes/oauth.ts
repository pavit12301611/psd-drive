import { Hono } from 'hono'
import { get, run } from '../db/index.ts'
import { config } from '../config.ts'
import { encrypt, newId, randomToken, signPayload, verifyPayload } from '../lib/crypto.ts'
import { badRequest } from '../lib/errors.ts'
import { log } from '../lib/logger.ts'
import { requireUser } from '../middleware/auth.ts'
import { logActivity } from '../services/activity.ts'
import { GoogleProvider } from '../providers/google.ts'
import { googleOAuth } from '../services/settings.ts'
import { syncAccountQuota } from '../services/quota.ts'
import { requestOrigin } from './shares.ts'

export const oauthRouter = new Hono()

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'openid',
  'email',
  'profile',
]

/**
 * Google OAuth connect flow.
 *
 * The browser has to leave the app for consent, so we cannot send a Bearer
 * token. Instead the authenticated client asks for a short-lived signed state
 * and the callback resolves the user from it.
 */
oauthRouter.post('/google/url', requireUser, async (c) => {
  const user = c.get('user')
  const creds = googleOAuth()
  if (!creds) {
    throw badRequest('Google OAuth is not configured yet. Add a client ID and secret in Settings.')
  }

  // Derive the callback from the live request so the flow works on localhost,
  // a custom domain, or behind a proxy without editing APP_URL.
  const redirectUri = `${requestOrigin(c)}/api/oauth/google/callback`
  const state = signPayload({ userId: user.id, redirectUri, nonce: randomToken(8) }, 900)

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
  url.searchParams.set('client_id', creds.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('access_type', 'offline')
  url.searchParams.set('prompt', 'consent select_account')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', state)

  return c.json({ url: url.toString(), redirectUri })
})

oauthRouter.get('/google/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const error = c.req.query('error')

  const redirect = (query: string) => c.redirect(`${config.appUrl}/accounts?${query}`, 302)

  if (error) return redirect(`google=error&message=${encodeURIComponent(error)}`)
  if (!code || !state) return redirect('google=error&message=missing_code')

  const payload = verifyPayload<{ userId: string; redirectUri: string }>(state)
  if (!payload) return redirect('google=error&message=invalid_state')

  const creds = googleOAuth()
  if (!creds) return redirect('google=error&message=not_configured')

  // The token exchange must repeat the exact redirect_uri used to authorize.
  const redirectUri = payload.redirectUri || creds.redirectUri

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    })

    const tokens = (await tokenRes.json()) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      scope?: string
      error_description?: string
    }

    if (!tokenRes.ok || !tokens.access_token) {
      return redirect(`google=error&message=${encodeURIComponent(tokens.error_description ?? 'token_exchange_failed')}`)
    }

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    const profile = (await profileRes.json()) as { id?: string; email?: string; name?: string; picture?: string }
    if (!profile.id) return redirect('google=error&message=profile_unavailable')

    const folderId = await GoogleProvider.ensureAppFolder(tokens.access_token)
    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000
    const now = Date.now()

    const existing = get<{ id: string; refresh_token: string | null }>(
      'select id, refresh_token from accounts where user_id = ? and provider = ? and provider_account_id = ?',
      payload.userId,
      'google',
      profile.id,
    )

    const refreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : (existing?.refresh_token ?? null)

    let accountId: string
    if (existing) {
      accountId = existing.id
      run(
        `update accounts set access_token = ?, refresh_token = ?, token_expires_at = ?, scopes = ?,
           label = ?, email = ?, avatar_url = ?, config = ?, enabled = 1, status = 'connected',
           last_error = NULL, updated_at = ? where id = ?`,
        encrypt(tokens.access_token),
        refreshToken,
        expiresAt,
        tokens.scope ?? SCOPES.join(' '),
        profile.name ?? profile.email ?? 'Google Drive',
        profile.email ?? null,
        profile.picture ?? null,
        JSON.stringify({ appFolderId: folderId }),
        now,
        accountId,
      )
    } else {
      accountId = newId()
      const priority = Number(get<{ c: number }>('select count(*) as c from accounts where user_id = ?', payload.userId)?.c ?? 0)
      run(
        `insert into accounts (id, user_id, provider, label, email, avatar_url, provider_account_id,
           access_token, refresh_token, token_expires_at, scopes, config, total_bytes, used_bytes,
           available_bytes, priority, enabled, status, created_at, updated_at)
         values (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, 1, 'connected', ?, ?)`,
        accountId,
        payload.userId,
        profile.name ?? profile.email ?? 'Google Drive',
        profile.email ?? null,
        profile.picture ?? null,
        profile.id,
        encrypt(tokens.access_token),
        refreshToken,
        expiresAt,
        tokens.scope ?? SCOPES.join(' '),
        JSON.stringify({ appFolderId: folderId }),
        priority,
        now,
        now,
      )
    }

    logActivity({
      userId: payload.userId,
      action: existing ? 'account.reconnected' : 'account.connected',
      entityType: 'account',
      entityId: accountId,
      entityName: profile.email ?? 'Google Drive',
      meta: { provider: 'google' },
    })

    const account = get<Parameters<typeof syncAccountQuota>[0]>('select * from accounts where id = ?', accountId)
    if (account) void syncAccountQuota(account)

    return redirect('google=connected')
  } catch (err) {
    log.error('google oauth failed', { error: (err as Error).message })
    return redirect(`google=error&message=${encodeURIComponent((err as Error).message)}`)
  }
})
