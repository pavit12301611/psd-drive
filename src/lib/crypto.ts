import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'
import { config } from '../config.ts'

/* ------------------------------------------------------------------ *
 * Credential encryption (AES-256-GCM)
 * ------------------------------------------------------------------ */

const KEY = config.secret

export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', KEY, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `v1.${iv.toString('base64url')}.${enc.toString('base64url')}.${tag.toString('base64url')}`
}

export function decrypt(payload: string | null | undefined): string {
  if (!payload) return ''
  if (!payload.startsWith('v1.')) return payload
  const [, ivB64, dataB64, tagB64] = payload.split('.')
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8')
}

/* ------------------------------------------------------------------ *
 * Password hashing — scrypt (built into Node, no native module)
 * ------------------------------------------------------------------ */

const SCRYPT_N = 16384
const SCRYPT_r = 8
const SCRYPT_p = 1

export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password.normalize('NFKC'), salt, 64, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p, maxmem: 64 * 1024 * 1024 })
  return `scrypt$${SCRYPT_N}$${SCRYPT_r}$${SCRYPT_p}$${salt.toString('base64url')}$${hash.toString('base64url')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = stored.split('$')
    if (scheme !== 'scrypt') return false
    const expected = Buffer.from(hashB64, 'base64url')
    const actual = scryptSync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    })
    return timingSafeEqual(expected, actual)
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 * Tokens & IDs
 * ------------------------------------------------------------------ */

export const newId = (): string => randomUUID()
export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url')
export const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex')
export const hmac = (value: string): string => createHmac('sha256', KEY).update(value).digest('hex')

/** Constant-time string compare that does not leak length. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(sha256(a), 'hex')
  const bb = Buffer.from(sha256(b), 'hex')
  return timingSafeEqual(ab, bb)
}

/* ------------------------------------------------------------------ *
 * Signed payloads (share links, preview tokens)
 * ------------------------------------------------------------------ */

export function signPayload(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds }
  const raw = Buffer.from(JSON.stringify(body)).toString('base64url')
  return `${raw}.${hmac(raw).slice(0, 32)}`
}

export function verifyPayload<T extends Record<string, unknown>>(token: string): (T & { exp: number }) | null {
  const [raw, sig] = token.split('.')
  if (!raw || !sig) return null
  const expected = hmac(raw).slice(0, 32)
  if (!safeEqual(sig, expected)) return null
  try {
    const body = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (typeof body.exp === 'number' && body.exp < Math.floor(Date.now() / 1000)) return null
    return body
  } catch {
    return null
  }
}
