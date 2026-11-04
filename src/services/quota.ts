import { run } from '../db/index.ts'
import { log } from '../lib/logger.ts'
import {
  type AccountRow,
  buildProvider,
  effectiveAvailable,
  listAccounts,
  usageByAccount,
} from './accounts.ts'

const STALE_AFTER_MS = 5 * 60_000

/**
 * Refresh one account's quota from the provider and persist it.
 * Google is the only provider with a real quota API; for the others we derive
 * usage from our own index, which is exact and instant.
 */
export async function syncAccountQuota(account: AccountRow): Promise<void> {
  try {
    const provider = buildProvider(account)
    const quota = await provider.quota()

    if (account.provider === 'google') {
      run(
        `update accounts set total_bytes = ?, used_bytes = ?, available_bytes = ?,
           quota_synced_at = ?, status = 'connected', last_error = NULL, updated_at = ? where id = ?`,
        quota.total,
        quota.used,
        quota.available,
        Date.now(),
        Date.now(),
        account.id,
      )
      return
    }

    const used = Number(usageByAccount(account.user_id).get(account.id) ?? 0)
    const total = account.total_bytes ?? quota.total
    run(
      `update accounts set total_bytes = ?, used_bytes = ?, available_bytes = ?,
         quota_synced_at = ?, status = 'connected', last_error = NULL, updated_at = ? where id = ?`,
      total,
      used,
      total == null ? quota.available : Math.max(0, total - used),
      Date.now(),
      Date.now(),
      account.id,
    )
  } catch (err) {
    const message = (err as Error).message.slice(0, 300)
    log.warn('quota sync failed', { account: account.label, error: message })
    run('update accounts set last_error = ?, updated_at = ? where id = ?', message, Date.now(), account.id)
  }
}

/** Fire-and-forget refresh; never blocks a response. */
export function revalidateQuotas(userId: string): void {
  const accounts = listAccounts(userId).filter(
    (a) => a.enabled && (a.provider === 'google' ? !a.quota_synced_at || Date.now() - a.quota_synced_at > STALE_AFTER_MS : false),
  )
  for (const account of accounts) {
    void syncAccountQuota(account)
  }
}

export async function refreshAllQuotas(userId: string): Promise<void> {
  await Promise.all(listAccounts(userId).map((account) => syncAccountQuota(account)))
}

export type PoolSummary = {
  accounts: {
    id: string
    label: string
    provider: string
    usedBytes: number
    totalBytes: number | null
    availableBytes: number | null
    sharePct: number
    status: string
    isDemo: boolean
    detail: string
  }[]
  totalBytes: number | null
  usedBytes: number
  availableBytes: number | null
  usedPct: number
  accountCount: number
}

export function poolSummary(userId: string): PoolSummary {
  const accounts = listAccounts(userId)
  const usage = usageByAccount(userId)

  let total = 0
  let used = 0
  let available = 0
  let hasUnlimited = false

  const items = accounts.map((account) => {
    const accountUsed = account.provider === 'google' ? (account.used_bytes ?? 0) : (usage.get(account.id) ?? 0)
    const accountAvailable = effectiveAvailable(account, accountUsed)
    if (account.total_bytes == null) hasUnlimited = true
    else total += account.total_bytes
    used += accountUsed
    available += accountAvailable ?? 0

    return {
      id: account.id,
      label: account.label,
      provider: account.provider,
      usedBytes: accountUsed,
      totalBytes: account.total_bytes,
      availableBytes: accountAvailable,
      sharePct: account.total_bytes ? Math.min(100, (accountUsed / account.total_bytes) * 100) : 0,
      status: account.status,
      isDemo: Boolean(account.is_demo),
      detail: account.provider === 'google' ? 'Google Drive' : account.provider === 's3' ? 'S3 bucket' : 'Local disk',
    }
  })

  const effectiveTotal = hasUnlimited ? null : total
  return {
    accounts: items,
    totalBytes: effectiveTotal,
    usedBytes: used,
    availableBytes: hasUnlimited ? null : available,
    usedPct: effectiveTotal ? Math.min(100, (used / effectiveTotal) * 100) : 0,
    accountCount: accounts.length,
  }
}
