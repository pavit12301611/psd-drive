import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { get, run } from '../db/index.ts'
import { config } from '../config.ts'
import { encrypt, newId, randomToken, safeEqual, signPayload, verifyPayload } from '../lib/crypto.ts'
import { badRequest } from '../lib/errors.ts'
import { log } from '../lib/logger.ts'
import { requireUser } from '../middleware/auth.ts'
import { logActivity } from '../services/activity.ts'
import { GoogleProvider } from '../providers/google.ts'
import { googleOAuth } from '../services/settings.ts'
import { forgetToken } from '../services/google-auth.ts'
import { requestOrigin } from './shares.ts'

/**
 * Google Drive connection flow.
 *
 * 1. `POST /google/url` (authenticated) mints a short-lived signed `state` and
 *    stores a matching nonce in an http-only cookie on this origin.
 * 2. The browser visits Google's consent screen and comes back to
 *    `/google/callback` with a one-time code.
 * 3. The callback checks the nonce (so a link crafted by somebody else cannot
 *    attach *their* Drive to *your* account), exchanges the code, proves the
 *    Drive API is actually reachable, then stores the account.
 */

export const oauthRouter = new Hono()

const NONCE_COOKIE = 'psd_oauth'

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'openid',
  'email',
  'profile',
]

/** Machine-readable reasons the UI can explain properly. */
const HINTS: Record<string, string> = {
  access_denied: 'You cancelled the Google consent screen, so nothing was connected.',
  org_internal:
    'This OAuth app is set to "Internal". Add your Google account as a test user (or publish the app) in Google Cloud Console.',
  invalid_client: 'Google rejected the client ID or secret. Re-copy them from Google Cloud Console.',
  redirect_uri_mismatch:
    'The redirect URI is not registered. Add the exact URL shown on this page to "Authorised redirect URIs" in Google Cloud Console.',
  invalid_grant: 'Google rejected the code exchange. Try connecting again.',
  invalid_state: 'That connection link expired. Start the Google connection again.',
  state_mismatch: 'That connection link was opened in a different browser. Start again from this page.',
  not_configured: 'Google OAuth credentials are missing. Add the client ID and secret first.',
  drive_permission_required:
    'Google did not grant Drive access. Reconnect and keep the Drive permission ticked on the consent screen.',
  no_refresh_token:
    'Google did not return a refresh token. Reconnect and make sure "offline access" is allowed for this OAuth client.',
  drive_api_disabled:
    'The Google Drive API is disabled for this project. Enable it in Google Cloud Console, then reconnect.',
  profile_unavailable: 'Could not read your Google profile. Check the account and try again.',
  token_exchange_failed: 'Google rejected the code exchange. Try connecting again.',
}
function isSecure(c: Context): boolean {
  return (
    requestOrigin(c).startsWith('https://') || c.req.header('x-forwarded-proto') === 'https'
  )
}

/** Build the ?google=…&code=…&message=… query the accounts page understands. */
function failure(query: string, code: string, detail?: string): string {
  const params = new URLSearchParams({ google: query, code })
  if (detail) params.set('message', detail.slice(0, 300))
  return params.toString()
}

oauthRouter.post('/google/url', requireUser, async (c) => {
  const user = c.get('user')
  const creds = googleOAuth()
  if (!creds) {
    throw badRequest('Google OAuth is not configured yet. Add a client ID and secret in Settings → Google.')
  }

  // Derive the callback from the live request so the flow works on localhost,
  // a custom domain, or behind a proxy without editing APP_URL.
  const redirectUri = `${requestOrigin(c)}/api/oauth/google/callback`
  const nonce = randomToken(16)
  const state = signPayload({ userId: user.id, redirectUri, nonce }, 900)

  setCookie(c, NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isSecure(c),
    path: '/api/oauth',
    maxAge: 900,
  })

  const url = new URL(config.google.authUrl)
  url.searchParams.set('client_id', creds.clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('access_type', 'offline')
  // `prompt=consent` is what guarantees a refresh token on every connect,
  // including reconnects of an account that was granted before.
  url.searchParams.set('prompt', 'consent select_account')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', state)

  return c.json({ url: url.toString(), redirectUri })
})

oauthRouter.get('/google/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const googleError = c.req.query('error')
  const nonce = getCookie(c, NONCE_COOKIE)

  const back = (query: string) => c.redirect(`${requestOrigin(c)}/accounts?${query}`, 302)
  const fail = (codeName: string, detail?: string) => {
    deleteCookie(c, NONCE_COOKIE, { path: '/api/oauth' })
    return back(failure('error', codeName, detail ?? HINTS[codeName]))
  }

  if (googleError) {
    const known = HINTS[googleError] ? googleError : 'token_exchange_failed'
    return fail(known, HINTS[known] ?? c.req.query('error_description'))
  }
  if (!code || !state) return fail('invalid_state')

  const payload = verifyPayload<{ userId: string; redirectUri: string; nonce: string }>(state)
  if (!payload) return fail('invalid_state')

  deleteCookie(c, NONCE_COOKIE, { path: '/api/oauth' })

  // CSRF binding: the state must come back to the same browser that started
  // the flow.
  if (!nonce || !payload.nonce || !safeEqual(nonce, payload.nonce)) {
    return fail('state_mismatch')
  }

  const creds = googleOAuth()
  if (!creds) return fail('not_configured')

  // The token exchange must repeat the exact redirect_uri used to authorize.
  const redirectUri = payload.redirectUri || creds.redirectUri

  try {
    const tokenRes = await fetch(config.google.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(20_000),
    })

    const tokens = (await tokenRes.json().catch(() => ({}))) as {
      access_token?: string
      refresh_token?: string
      expires_in?: number
      scope?: string
      error?: string
      error_description?: string
    }

    if (!tokenRes.ok || !tokens.access_token) {
      log.warn('google token exchange failed', {
        status: tokenRes.status,
        error: tokens.error,
        description: tokens.error_description,
      })
      const codeName =
        tokens.error === 'invalid_client'
          ? 'invalid_client'
          : tokens.error === 'redirect_uri_mismatch'
            ? 'redirect_uri_mismatch'
            : 'token_exchange_failed'
      return fail(codeName, tokens.error_description)
    }

    // The user can untick the Drive checkbox on the consent screen. Without
    // the scope every later Drive call would fail, so catch it here.
    const granted = tokens.scope ?? ''
    if (!/auth\/drive(\.|$|\/|\s)/.test(granted)) {
      return fail('drive_permission_required')
    }

    // Prove the Drive API is enabled *before* saving a broken account.
    let inspected: Awaited<ReturnType<typeof GoogleProvider.inspect>>
    try {
      inspected = await GoogleProvider.inspect(tokens.access_token)
    } catch (err) {
      const codeName = (err as { code?: string }).code === 'DRIVE_API_DISABLED' ? 'drive_api_disabled' : 'token_exchange_failed'
      return fail(codeName, (err as Error).message)
    }

    const profileRes = await fetch(config.google.userinfoUrl, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    })
    const profile = profileRes.ok
      ? ((await profileRes.json()) as { id?: string; email?: string; name?: string; picture?: string })
      : {}

    const providerAccountId = profile.id ?? inspected.email
    if (!providerAccountId) return fail('profile_unavailable')

    const existing = get<{ id: string; refresh_token: string | null }>(
      'select id, refresh_token from accounts where user_id = ? and provider = ? and provider_account_id = ?',
      payload.userId,
      'google',
      providerAccountId,
    )

    if (!tokens.refresh_token && !existing?.refresh_token) return fail('no_refresh_token')

    const expiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000
    const refreshToken = tokens.refresh_token ? encrypt(tokens.refresh_token) : (existing?.refresh_token ?? null)
    const label = profile.name ?? inspected.name ?? profile.email ?? inspected.email ?? 'Google Drive'
    const email = profile.email ?? inspected.email ?? null
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
        granted || SCOPES.join(' '),
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
      // Force a fresh folder lookup: the old one may belong to a revoked grant.
      run('update accounts set config = null where id = ?', accountId)
    } else {
      accountId = newId()
      const priority =
        Number(get<{ c: number }>('select count(*) as c from accounts where user_id = ?', payload.userId)?.c ?? 0) ?? 0
      run(
        `insert into accounts (id, user_id, provider, label, email, avatar_url, provider_account_id,
           access_token, refresh_token, token_expires_at, scopes, config, total_bytes, used_bytes,
           available_bytes, quota_synced_at, priority, enabled, status, created_at, updated_at)
         values (?, ?, 'google', ?, ?, ?, ?, ?, ?, ?, ?, null, ?, ?, ?, ?, ?, 1, 'connected', ?, ?)`,
        accountId,
        payload.userId,
        label,
        email,
        profile.picture ?? null,
        providerAccountId,
        encrypt(tokens.access_token),
        refreshToken,
        expiresAt,
        granted || SCOPES.join(' '),
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
      userId: payload.userId,
      action: existing ? 'account.reconnected' : 'account.connected',
      entityType: 'account',
      entityId: accountId,
      entityName: email ?? label,
      meta: { provider: 'google', total: inspected.quota.total },
    })

    log.info('google account connected', { email, quotaTotal: inspected.quota.total })
    return back('google=connected')
  } catch (err) {
    log.error('google oauth failed', { error: (err as Error).message })
    return fail('token_exchange_failed', (err as Error).message)
  }
})
