import { Hono, type Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { get, run } from '../db/index.ts'
import { config } from '../config.ts'
import { hashPassword, newId, randomToken, safeEqual, signPayload, verifyPayload } from '../lib/crypto.ts'
import { HttpError, badRequest } from '../lib/errors.ts'
import { log } from '../lib/logger.ts'
import { requireUser } from '../middleware/auth.ts'
import { GoogleProvider } from '../providers/google.ts'
import { googleOAuth } from '../services/settings.ts'
import { cookieSecurity, issueSession } from '../services/session.ts'
import { connectGoogleAccount } from '../services/google-connect.ts'
import { requestOrigin } from './shares.ts'

/**
 * Google, twice.
 *
 *  1. **Connect a drive** (authenticated). `POST /google/url` mints a signed
 *     `state` and a browser-bound nonce, the user consents, and the callback
 *     stores the account.
 *  2. **Sign in with Google** (public). `GET /google/login/url` uses the same
 *     consent screen with `mode: 'login'`; the callback finds or creates the
 *     user, opens a session, and connects the first Drive on the way — the way
 *     9Drive's "Continue with Google" does.
 *
 * The nonce cookie is what makes both safe: a link crafted by somebody else
 * cannot attach *their* Google account to *your* PSDrive, and cannot silently
 * sign you in to their account.
 */

export const oauthRouter = new Hono()

const NONCE_COOKIE = 'psd_oauth'

const SCOPES = ['https://www.googleapis.com/auth/drive', 'openid', 'email', 'profile']

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
  state_mismatch: 'That link was opened in a different browser. Start again from this page.',
  not_configured: 'Google OAuth credentials are missing. Add the client ID and secret first.',
  drive_permission_required:
    'Google did not grant Drive access. Reconnect and keep the Drive permission ticked on the consent screen.',
  no_refresh_token:
    'Google did not return a refresh token. Reconnect and make sure "offline access" is allowed for this OAuth client.',
  drive_api_disabled:
    'The Google Drive API is disabled for this project. Enable it in Google Cloud Console, then reconnect.',
  profile_unavailable: 'Could not read your Google profile. Check the account and try again.',
  token_exchange_failed: 'Google rejected the code exchange. Try connecting again.',
  signup_closed: 'This instance is not accepting new accounts. Ask the owner to add you.',
}

function buildAuthUrl(redirectUri: string, state: string, clientId: string): string {
  const url = new URL(config.google.authUrl)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', SCOPES.join(' '))
  url.searchParams.set('access_type', 'offline')
  // `prompt=consent` is what guarantees a refresh token on every connect,
  // including reconnects of an account that was granted before.
  url.searchParams.set('prompt', 'consent select_account')
  url.searchParams.set('include_granted_scopes', 'true')
  url.searchParams.set('state', state)
  return url.toString()
}

function startFlow(c: Context, payload: Record<string, unknown>, redirectUri: string) {
  const nonce = randomToken(16)
  const state = signPayload({ ...payload, redirectUri, nonce }, 900)
  const { secure } = cookieSecurity(c)

  setCookie(c, NONCE_COOKIE, nonce, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/api/oauth',
    maxAge: 900,
  })

  return state
}

/* ------------------------- connect a drive (authed) ------------------------ */

oauthRouter.post('/google/url', requireUser, async (c) => {
  const user = c.get('user')
  const creds = googleOAuth()
  if (!creds) {
    throw badRequest('Google OAuth is not configured yet. Add a client ID and secret in Settings → Google.')
  }

  // Derive the callback from the live request so the flow works on localhost,
  // a custom domain, or behind a proxy without editing APP_URL.
  const redirectUri = `${requestOrigin(c)}/api/oauth/google/callback`
  const state = startFlow(c, { userId: user.id, mode: 'connect' }, redirectUri)

  return c.json({ url: buildAuthUrl(redirectUri, state, creds.clientId), redirectUri })
})

/* --------------------------- sign in with Google --------------------------- */

oauthRouter.get('/google/login/url', (c) => {
  const creds = googleOAuth()
  if (!creds) throw badRequest('Google sign-in is not configured on this instance.')

  // New accounts may be blocked, but existing Google identities can always
  // sign in — that decision is made in the callback.
  const next = c.req.query('next')
  const safeNext = next && /^\/(?!\/)/.test(next) ? next : '/drive'
  const redirectUri = `${requestOrigin(c)}/api/oauth/google/callback`
  const state = startFlow(c, { mode: 'login', next: safeNext }, redirectUri)

  return c.json({ url: buildAuthUrl(redirectUri, state, creds.clientId), redirectUri })
})

/* -------------------------------- callback -------------------------------- */

oauthRouter.get('/google/callback', async (c) => {
  const code = c.req.query('code')
  const state = c.req.query('state')
  const googleError = c.req.query('error')
  const nonce = getCookie(c, NONCE_COOKIE)
  const origin = requestOrigin(c)

  const payload = state
    ? verifyPayload<{ userId?: string; redirectUri: string; nonce: string; mode: 'connect' | 'login'; next?: string }>(
        state,
      )
    : null
  const isLogin = payload?.mode === 'login'
  const landing = isLogin ? '/login' : '/accounts'

  const back = (query: string) => c.redirect(`${origin}${landing}?${query}`, 302)
  const fail = (codeName: string, detail?: string) => {
    deleteCookie(c, NONCE_COOKIE, { path: '/api/oauth' })
    const params = new URLSearchParams({
      google: 'error',
      code: codeName,
      message: detail ?? HINTS[codeName] ?? 'Google did not complete the request.',
    })
    return back(params.toString())
  }

  if (googleError) {
    const known = HINTS[googleError] ? googleError : 'token_exchange_failed'
    return fail(known, HINTS[known])
  }
  if (!code || !state) return fail('invalid_state')

  if (!payload) return fail('invalid_state')

  deleteCookie(c, NONCE_COOKIE, { path: '/api/oauth' })

  if (!nonce || !payload.nonce || !safeEqual(nonce, payload.nonce)) return fail('state_mismatch')

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

    const accessToken = tokens.access_token
    if (!tokenRes.ok || !accessToken) {
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

    // The user can untick the Drive checkbox on the consent screen. Without the
    // scope every later Drive call would fail, so catch it here.
    const granted = tokens.scope ?? ''
    if (!/auth\/drive(\.|$|\/|\s)/.test(granted)) return fail('drive_permission_required')

    // Prove the Drive API is enabled *before* saving a broken account.
    let inspected: Awaited<ReturnType<typeof GoogleProvider.inspect>>
    try {
      inspected = await GoogleProvider.inspect(accessToken)
    } catch (err) {
      const codeName = (err as { code?: string }).code === 'DRIVE_API_DISABLED' ? 'drive_api_disabled' : 'token_exchange_failed'
      return fail(codeName, (err as Error).message)
    }

    const profileRes = await fetch(config.google.userinfoUrl, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const profile = profileRes.ok
      ? ((await profileRes.json()) as { id?: string; email?: string; name?: string; picture?: string })
      : {}

    /* ----------------------------- sign in ----------------------------- */

    if (isLogin) {
      if (!profile.id || !profile.email) return fail('profile_unavailable')

      let user = get<{ id: string; name: string; email: string; avatar_url: string | null; role: string; google_id: string | null }>(
        'select id, name, email, avatar_url, role, google_id from users where google_id = ?',
        profile.id,
      )

      if (!user) {
        const byEmail = get<{ id: string; name: string; email: string; avatar_url: string | null; role: string; google_id: string | null }>(
          'select id, name, email, avatar_url, role, google_id from users where email = ?',
          profile.email,
        )

        if (byEmail) {
          // Existing password account, now also linked to Google.
          run('update users set google_id = ?, updated_at = ? where id = ?', profile.id, Date.now(), byEmail.id)
          user = { ...byEmail, google_id: profile.id }
        } else {
          const users = Number(get<{ c: number }>('select count(*) as c from users')?.c ?? 0)
          if (users > 0 && !config.allowSignup) return fail('signup_closed')

          const id = newId()
          const now = Date.now()
          // No password: the account is reachable only through Google. The
          // column stores an unusable random hash rather than null.
          run(
            `insert into users (id, name, email, password_hash, avatar_url, role, status, google_id, created_at, updated_at)
             values (?, ?, ?, ?, ?, 'owner', 'active', ?, ?, ?)`,
            id,
            profile.name ?? profile.email,
            profile.email,
            hashPassword(randomToken(32)),
            profile.picture ?? null,
            profile.id,
            now,
            now,
          )
          user = {
            id,
            name: profile.name ?? profile.email,
            email: profile.email,
            avatar_url: profile.picture ?? null,
            role: 'owner',
            google_id: profile.id,
          }
        }
      }

      if (!tokens.refresh_token && !get('select id from accounts where user_id = ? and provider = ?', user.id, 'google')) {
        // Sign-in can still succeed; only the auto-connected Drive needs a
        // refresh token, and it is created lazily on connect.
        log.warn('google sign-in without a refresh token; drive not auto-connected', { email: user.email })
      } else {
        await connectGoogleAccount({
          userId: user.id,
          tokens: { ...tokens, access_token: accessToken },
          profile,
          inspected,
          fallbackLabel: 'Google Drive',
        })
      }

      issueSession(c, { id: user.id, email: user.email, name: user.name })
      log.info('signed in with google', { email: user.email })
      // The session rides in http-only cookies, so a plain SPA redirect is all
      // that is needed — the app restores it on load.
      return c.redirect(`${origin}${payload.next ?? '/drive'}`, 302)
    }

    /* ---------------------------- connect ------------------------------ */

    if (!payload.userId) return fail('invalid_state')
    if (!tokens.refresh_token && !get(
      'select id from accounts where user_id = ? and provider = ? and provider_account_id = ?',
      payload.userId,
      'google',
      profile.id ?? inspected.email,
    )) {
      return fail('no_refresh_token')
    }

    await connectGoogleAccount({
      userId: payload.userId,
      tokens: { ...tokens, access_token: accessToken },
      profile,
      inspected,
      fallbackLabel: 'Google Drive',
    })

    return back('google=connected')
  } catch (err) {
    log.error('google oauth failed', { error: (err as Error).message })
    if (err instanceof HttpError) return fail(err.code.toLowerCase(), err.message)
    return fail('token_exchange_failed', (err as Error).message)
  }
})

/** Handy for the sign-in button: does this instance offer Google auth at all? */
oauthRouter.get('/google/status', (c) =>
  c.json({ configured: Boolean(googleOAuth()), signupOpen: config.allowSignup }),
)
