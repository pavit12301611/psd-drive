import type { Context } from 'hono'
import { setCookie } from 'hono/cookie'
import { config } from '../config.ts'
import { run } from '../db/index.ts'
import { newId, randomToken, sha256 } from '../lib/crypto.ts'
import { signAccessToken } from '../lib/jwt.ts'

/**
 * One place that mints a browser session.
 *
 * Both the password flow and "Continue with Google" end in the same cookies, so
 * the rest of the app cannot tell them apart — which is exactly what you want
 * from an auth layer.
 */

export const REFRESH_COOKIE = 'psd_rt'

/**
 * The access token is *also* mirrored into an http-only cookie.
 *
 * <img>, <video>, <iframe> and plain download links cannot send an
 * Authorization header, so media and downloads authenticate with this cookie.
 * `requireUser` only accepts it for safe methods (GET/HEAD), so a cross-site
 * form or fetch can never use it to change anything.
 */
export const ACCESS_COOKIE = 'psd_at'

export type SessionUser = { id: string; email: string; name: string }

export function cookieSecurity(c: Context): { secure: boolean } {
  const forwarded = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim()
  return { secure: forwarded === 'https' || config.appUrl.startsWith('https://') }
}

export function issueSession(c: Context, user: SessionUser, options: { rotateFrom?: string } = {}) {
  if (options.rotateFrom) {
    run('update sessions set revoked_at = ? where token_hash = ?', Date.now(), sha256(options.rotateFrom))
  }

  const refreshToken = randomToken(32)
  const expiresAt = Date.now() + config.refreshTokenTtl * 1000
  const { secure } = cookieSecurity(c)

  run(
    'insert into sessions (id, user_id, token_hash, user_agent, ip, expires_at, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    newId(),
    user.id,
    sha256(refreshToken),
    c.req.header('user-agent')?.slice(0, 200) ?? null,
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
    expiresAt,
    Date.now(),
  )

  setCookie(c, REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/api/auth',
    maxAge: config.refreshTokenTtl,
  })

  const accessToken = signAccessToken(user)
  setCookie(c, ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
    maxAge: config.accessTokenTtl,
  })

  return {
    accessToken,
    expiresIn: config.accessTokenTtl,
    user: { id: user.id, email: user.email, name: user.name },
  }
}

export function publicUser(user: {
  id: string
  name: string
  email: string
  avatarUrl?: string | null
  role?: string
}) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl ?? null,
    role: user.role ?? 'owner',
  }
}
