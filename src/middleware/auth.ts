import type { Context, MiddlewareHandler } from 'hono'
import { getCookie } from 'hono/cookie'
import { get, run } from '../db/index.ts'
import { sha256 } from '../lib/crypto.ts'
import { unauthorized } from '../lib/errors.ts'
import { verifyAccessToken } from '../lib/jwt.ts'

export type AuthUser = {
  id: string
  name: string
  email: string
  avatarUrl: string | null
  role: string
}

export type ApiKeyPrincipal = {
  id: string
  userId: string
  name: string
  scopes: string[]
}

declare module 'hono' {
  interface ContextVariableMap {
    user: AuthUser
    apiKey: ApiKeyPrincipal
    requestId: string
  }
}

export function loadUser(id: string): AuthUser | null {
  const row = get<{
    id: string
    name: string
    email: string
    avatar_url: string | null
    role: string
    status: string
  }>('select id, name, email, avatar_url, role, status from users where id = ?', id)
  if (!row || row.status !== 'active') return null
  return { id: row.id, name: row.name, email: row.email, avatarUrl: row.avatar_url, role: row.role }
}

export function bearerToken(c: Context): string | null {
  const header = c.req.header('authorization')
  if (!header) return null
  const [scheme, token] = header.split(' ')
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null
  return token
}

/**
 * Requires a valid access token.
 *
 * Bearer tokens are accepted on every method. The mirrored cookie is only
 * accepted for safe methods, which is what lets <img>, <video> and download
 * links work without ever exposing a token to JavaScript or to a CSRF vector.
 */
export const requireUser: MiddlewareHandler = async (c, next) => {
  let token = bearerToken(c)

  if (!token && (c.req.method === 'GET' || c.req.method === 'HEAD')) {
    token = getCookie(c, 'psd_at') ?? null
  }

  if (!token) throw unauthorized('Missing access token.')
  const claims = verifyAccessToken(token)
  if (!claims) throw unauthorized('Your session expired. Refreshing…')
  const user = loadUser(claims.sub)
  if (!user) throw unauthorized('This account is no longer active.')
  c.set('user', user)
  await next()
}

/** Requires a valid API key (`X-API-Key` or `Authorization: ApiKey <key>`). */
export const requireApiKey: MiddlewareHandler = async (c, next) => {
  const header = c.req.header('x-api-key') || c.req.header('authorization')?.replace(/^ApiKey\s+/i, '')
  if (!header) throw unauthorized('Provide an API key in the X-API-Key header.')

  const row = get<{
    id: string
    user_id: string
    name: string
    scopes: string
    revoked_at: number | null
  }>('select id, user_id, name, scopes, revoked_at from api_keys where key_hash = ?', sha256(header))

  if (!row || row.revoked_at) throw unauthorized('That API key is invalid or revoked.')

  run('update api_keys set last_used_at = ? where id = ?', Date.now(), row.id)
  c.set('apiKey', {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    scopes: row.scopes.split(',').map((s) => s.trim()).filter(Boolean),
  })
  const user = loadUser(row.user_id)
  if (user) c.set('user', user)
  await next()
}

export function assertScope(c: Context, scope: string): void {
  const key = c.get('apiKey')
  if (key && !key.scopes.includes(scope)) {
    throw unauthorized(`This API key is missing the "${scope}" scope.`)
  }
}
