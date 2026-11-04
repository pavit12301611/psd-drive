import { get, run } from '../db/index.ts'
import { config } from '../config.ts'
import { decrypt, encrypt } from '../lib/crypto.ts'

export type GoogleOAuth = {
  clientId: string
  clientSecret: string
  redirectUri: string
}

export function readSetting<T>(key: string, fallback: T): T {
  const row = get<{ value: string }>('select value from settings where key = ?', key)
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
  } catch {
    return fallback
  }
}

export function writeSetting(key: string, value: unknown): void {
  run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    Date.now(),
  )
}

export function deleteSetting(key: string): void {
  run('delete from settings where key = ?', key)
}

/** Global Google OAuth app credentials: env first, then values saved in the UI. */
export function googleOAuth(): GoogleOAuth | null {
  const stored = readSetting<{ clientId?: string; clientSecret?: string; redirectUri?: string } | null>(
    'google_oauth',
    null,
  )
  const clientId = config.google.clientId || stored?.clientId || ''
  const clientSecret = config.google.clientSecret || (stored?.clientSecret ? decrypt(stored.clientSecret) : '')
  const redirectUri =
    config.google.redirectUri || stored?.redirectUri || `${config.appUrl}/api/oauth/google/callback`

  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret, redirectUri }
}

export function saveGoogleOAuth(input: { clientId: string; clientSecret?: string; redirectUri?: string }): void {
  const existing = readSetting<{ clientId?: string; clientSecret?: string; redirectUri?: string } | null>(
    'google_oauth',
    null,
  )
  const secret = input.clientSecret ? encrypt(input.clientSecret) : (existing?.clientSecret ?? '')
  writeSetting('google_oauth', {
    clientId: input.clientId,
    clientSecret: secret,
    redirectUri: input.redirectUri || existing?.redirectUri || `${config.appUrl}/api/oauth/google/callback`,
  })
}
