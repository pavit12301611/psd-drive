import { all, get, pluck } from '../db/index.ts'
import { LocalProvider } from '../providers/local.ts'
import { GoogleProvider } from '../providers/google.ts'
import { S3Provider } from '../providers/s3.ts'
import type { StorageProvider } from '../providers/types.ts'
import { appFolderIdFor, accessTokenFor } from './google-auth.ts'

export type AccountRow = {
  id: string
  user_id: string
  provider: 'google' | 's3' | 'local' | string
  label: string
  email: string | null
  avatar_url: string | null
  provider_account_id: string
  access_token: string | null
  refresh_token: string | null
  token_expires_at: number | null
  scopes: string | null
  config: string | null
  total_bytes: number | null
  used_bytes: number
  available_bytes: number | null
  quota_synced_at: number | null
  priority: number
  enabled: number
  is_demo: number
  status: string
  last_error: string | null
  created_at: number
  updated_at: number
}

export type PublicAccount = {
  id: string
  provider: string
  label: string
  email: string | null
  avatarUrl: string | null
  totalBytes: number | null
  usedBytes: number
  availableBytes: number | null
  status: string
  isDemo: boolean
  priority: number
  detail: string
  lastError: string | null
  quotaSyncedAt: number | null
  createdAt: number
}

function s3Config(account: AccountRow) {
  return account.config ? (JSON.parse(account.config) as Record<string, unknown>) : {}
}

export function buildProvider(account: AccountRow): StorageProvider {
  const cfg = s3Config(account)

  if (account.provider === 'google') {
    return new GoogleProvider({
      getAccessToken: () => accessTokenFor(account),
      getAppFolderId: () => appFolderIdFor(account),
    })
  }

  if (account.provider === 's3') {
    return new S3Provider({
      bucket: String(cfg.bucket ?? ''),
      region: String(cfg.region ?? 'auto'),
      endpoint: cfg.endpoint ? String(cfg.endpoint) : undefined,
      accessKeyId: String(cfg.accessKeyId ?? ''),
      secretAccessKey: String(cfg.secretAccessKey ?? ''),
      forcePathStyle: Boolean(cfg.forcePathStyle),
      prefix: cfg.prefix ? String(cfg.prefix) : 'psdrive',
      quotaBytes: account.total_bytes,
    })
  }

  return new LocalProvider(account.id, { quotaBytes: account.total_bytes })
}

export function describeAccount(account: AccountRow): string {
  if (account.provider === 'google') return 'Google Drive'
  if (account.provider === 's3') {
    const cfg = s3Config(account)
    return [cfg.bucket, cfg.prefix].filter(Boolean).join('/') || 'S3 bucket'
  }
  return 'Local disk'
}

/**
 * Summed bytes per account in a single grouped query.
 *
 * Doing this once and passing the map around avoids an N+1 when rendering the
 * storage pool — the dashboard is the hottest read in the app.
 */
export function usageByAccount(userId: string): Map<string, number> {
  const rows = all<{ account_id: string; s: number }>(
    "select account_id, coalesce(sum(size_bytes), 0) as s from files where user_id = ? and status != 'purged' group by account_id",
    userId,
  )
  return new Map(rows.map((r) => [r.account_id, Number(r.s)]))
}

/**
 * Bytes this account can still accept.
 *
 * Google reports real quota, so we trust the synced numbers. For local/S3 we
 * derive usage from our own index against the configured quota, which stays
 * accurate the instant an upload finishes.
 */
export function effectiveAvailable(account: AccountRow, used?: number): number | null {
  if (account.provider === 'google') return account.available_bytes
  if (account.total_bytes == null) return account.available_bytes
  const consumed = used ?? 0
  return Math.max(0, account.total_bytes - consumed)
}

export function accountUsage(account: AccountRow, used?: number): number {
  if (account.provider === 'google') return account.used_bytes ?? 0
  return used ?? 0
}

export function toPublicAccount(account: AccountRow, used = 0): PublicAccount {
  const available = effectiveAvailable(account, used)
  return {
    id: account.id,
    provider: account.provider,
    label: account.label,
    email: account.email,
    avatarUrl: account.avatar_url,
    totalBytes: account.total_bytes,
    usedBytes: accountUsage(account, used),
    availableBytes: available,
    status: account.last_error ? 'error' : account.status,
    isDemo: Boolean(account.is_demo),
    priority: account.priority,
    detail: describeAccount(account),
    lastError: account.last_error,
    quotaSyncedAt: account.quota_synced_at,
    createdAt: account.created_at,
  }
}

export function listAccounts(userId: string): AccountRow[] {
  return all<AccountRow>('select * from accounts where user_id = ? order by priority asc, created_at asc', userId)
}

export function getAccount(userId: string, id: string): AccountRow | undefined {
  return get<AccountRow>('select * from accounts where id = ? and user_id = ?', id, userId)
}

export function primaryAccount(userId: string): AccountRow | undefined {
  return get<AccountRow>('select * from accounts where user_id = ? and enabled = 1 order by priority asc, created_at asc limit 1', userId)
}
