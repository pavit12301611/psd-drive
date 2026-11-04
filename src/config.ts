import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

/**
 * Configuration is resolved once at boot.
 *
 * Secrets are auto-generated and persisted to DATA_DIR/secret.key on first run so
 * `node src/server.ts` works with zero configuration — no .env hunting, no
 * "your JWT secret is too short" setup errors.
 */

const root = path.resolve(import.meta.dirname, '..')

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes'
}

function int(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

const dataDir = path.resolve(root, process.env.DATA_DIR || './data')
mkdirSync(dataDir, { recursive: true })

/** Persisted at-rest key for provider credentials. Never leaves the server. */
function loadSecret(): Buffer {
  const explicit = process.env.APP_SECRET
  if (explicit && explicit.length >= 32) return Buffer.from(explicit, 'utf8').subarray(0, 32)

  const keyPath = path.join(dataDir, 'secret.key')
  if (existsSync(keyPath)) return Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'hex')
  const generated = randomBytes(32)
  writeFileSync(keyPath, generated.toString('hex'), { mode: 0o600 })
  return generated
}

export const config = {
  root,
  dataDir,
  dbPath: process.env.DB_PATH || path.join(dataDir, 'psdrive.db'),
  blobDir: path.join(dataDir, 'blobs'),
  secret: loadSecret(),
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  appUrl: (process.env.APP_URL || `http://localhost:${int(process.env.PORT, 3000)}`).replace(/\/$/, ''),
  webDist: path.join(root, 'dist'),
  demoMode: bool(process.env.DEMO_MODE, true),
  trustProxy: bool(process.env.TRUST_PROXY, true),
  maxUploadBytes: int(process.env.MAX_UPLOAD_BYTES, 8 * 1024 * 1024 * 1024),
  accessTokenTtl: 15 * 60, // seconds
  refreshTokenTtl: 30 * 24 * 60 * 60, // seconds
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    redirectUri: process.env.GOOGLE_REDIRECT_URI || '',
  },
  logLevel: (process.env.LOG_LEVEL || 'info') as 'debug' | 'info' | 'warn' | 'error',
} as const

mkdirSync(config.blobDir, { recursive: true })

export type Config = typeof config
