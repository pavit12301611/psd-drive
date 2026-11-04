import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.ts'

/** Minimal HS256 JWT — 30 lines instead of a dependency. */

export type AccessClaims = {
  sub: string
  email: string
  name: string
  iat: number
  exp: number
}

const b64 = (input: Buffer | string) => Buffer.from(input).toString('base64url')

function signature(data: string): string {
  return createHmac('sha256', config.secret).update(data).digest('base64url')
}

export function signAccessToken(user: { id: string; email: string; name: string }): string {
  const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload: AccessClaims = {
    sub: user.id,
    email: user.email,
    name: user.name,
    iat: now,
    exp: now + config.accessTokenTtl,
  }
  const body = b64(JSON.stringify(payload))
  const unsigned = `${header}.${body}`
  return `${unsigned}.${signature(unsigned)}`
}

export function verifyAccessToken(token: string): AccessClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const expected = signature(`${header}.${body}`)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AccessClaims
    if (claims.exp * 1000 < Date.now()) return null
    return claims
  } catch {
    return null
  }
}
