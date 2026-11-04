import { HttpError } from '../lib/errors.ts'
import { readSetting, writeSetting } from './settings.ts'
import { type AccountRow, effectiveAvailable, listAccounts, usageByAccount } from './accounts.ts'

export type RoutingMode = 'most_available' | 'round_robin' | 'priority'

export type RoutingPolicy = {
  mode: RoutingMode
  /** Ordered account ids, used by `priority` mode. */
  order: string[]
}

const DEFAULT_POLICY: RoutingPolicy = { mode: 'most_available', order: [] }

export function getPolicy(userId: string): RoutingPolicy {
  const stored = readSetting<RoutingPolicy | null>(`routing:${userId}`, null)
  return stored ?? DEFAULT_POLICY
}

export function setPolicy(userId: string, policy: RoutingPolicy): RoutingPolicy {
  writeSetting(`routing:${userId}`, policy)
  return policy
}

type Candidate = { account: AccountRow; available: number }

/**
 * Pick the account that should receive the next upload.
 *
 * Rules that matter, in order:
 *  1. only enabled accounts with a known-or-infinite free space are candidates
 *  2. accounts must have room for the whole file (no half-written uploads)
 *  3. ties break on priority so users can pin their fastest account
 */
export function pickAccount(userId: string, size: number): AccountRow {
  const policy = getPolicy(userId)
  const accounts = listAccounts(userId).filter((a) => a.enabled)

  if (accounts.length === 0) {
    throw new HttpError(409, 'NO_ACCOUNTS', 'Connect a storage account before uploading.')
  }

  const usage = usageByAccount(userId)
  const candidates: Candidate[] = accounts
    .map((account) => ({ account, available: effectiveAvailable(account, usage.get(account.id) ?? 0) ?? Number.POSITIVE_INFINITY }))
    .filter((c) => c.available >= size)

  if (candidates.length === 0) {
    const totalFree = accounts.reduce(
      (sum, a) => sum + (effectiveAvailable(a, usage.get(a.id) ?? 0) ?? 0),
      0,
    )
    throw new HttpError(
      507,
      'STORAGE_FULL',
      totalFree > 0
        ? 'No single account has enough room for this file. Add an account or free up space.'
        : 'All connected accounts are full.',
      { totalFree },
    )
  }

  if (policy.mode === 'priority' && policy.order.length) {
    for (const id of policy.order) {
      const hit = candidates.find((c) => c.account.id === id)
      if (hit) return hit.account
    }
  }

  if (policy.mode === 'round_robin') {
    const key = `rr:${userId}`
    const cursor = readSetting<number>(key, 0)
    // Stable order so the cursor is meaningful across requests.
    const sorted = candidates.sort((a, b) => a.account.created_at - b.account.created_at)
    const chosen = sorted[cursor % sorted.length]
    writeSetting(key, cursor + 1)
    return chosen.account
  }

  // most_available (default)
  candidates.sort((a, b) => {
    if (b.available !== a.available) return b.available - a.available
    return a.account.priority - b.account.priority
  })
  return candidates[0].account
}
