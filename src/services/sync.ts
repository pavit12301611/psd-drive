import { all, run } from '../db/index.ts'
import { newId } from '../lib/crypto.ts'
import { log } from '../lib/logger.ts'
import { logActivity } from './activity.ts'
import { buildProvider, getAccount, listAccounts } from './accounts.ts'
import { syncAccountQuota } from './quota.ts'

/**
 * "Sync Drive" — Google is the source of truth, this index is the cache.
 *
 * PSDrive puts every upload into the `PSDrive` folder of a connected Drive. That
 * folder is a normal folder: people drag files into it from drive.google.com,
 * rename them there, or delete them there. Without this pass the app would slowly
 * drift from reality, so one call reconciles the whole folder:
 *
 *   added    — exists in Drive, not in the index → indexed
 *   updated  — renamed / resized in Drive        → row refreshed
 *   removed  — gone from Drive, still active     → moved to the recycle bin here
 *
 * It only ever reads metadata (one paged `files.list` per account); no file
 * bytes are downloaded, so syncing 10,000 files costs kilobytes, not gigabytes.
 */

export type AccountSyncResult = {
  accountId: string
  label: string
  added: number
  updated: number
  removed: number
}

export type SyncSummary = {
  added: number
  updated: number
  removed: number
  accounts: AccountSyncResult[]
  errors: { accountId: string; label: string; message: string }[]
}

type IndexRow = {
  id: string
  provider_file_id: string
  name: string
  size_bytes: number
  mime_type: string
  status: string
}

export async function syncDrive(userId: string, options: { accountId?: string } = {}): Promise<SyncSummary> {
  const accounts = listAccounts(userId).filter(
    (account) =>
      account.provider === 'google' && account.enabled && (!options.accountId || account.id === options.accountId),
  )

  const summary: SyncSummary = { added: 0, updated: 0, removed: 0, accounts: [], errors: [] }

  for (const listed of accounts) {
    // Re-read the row: quota/status may have moved since the list was taken.
    const account = getAccount(userId, listed.id)
    if (!account) continue

    const provider = buildProvider(account)
    if (!provider.list) continue

    try {
      const remote = await provider.list()
      const remoteIds = new Set(remote.map((file) => file.id))

      const indexed = all<IndexRow>(
        'select id, provider_file_id, name, size_bytes, mime_type, status from files where user_id = ? and account_id = ?',
        userId,
        account.id,
      )
      const byProviderId = new Map(indexed.map((row) => [row.provider_file_id, row]))

      let added = 0
      let updated = 0
      let removed = 0
      const now = Date.now()

      for (const file of remote) {
        const existing = byProviderId.get(file.id)

        if (!existing) {
          run(
            `insert into files (id, user_id, account_id, folder_id, provider_file_id, name, mime_type, size_bytes,
               status, starred, created_at, updated_at)
             values (?, ?, ?, null, ?, ?, ?, ?, 'active', 0, ?, ?)`,
            newId(),
            userId,
            account.id,
            file.id,
            file.name,
            file.mimeType || 'application/octet-stream',
            file.size,
            file.updatedAt || now,
            now,
          )
          added++
          continue
        }

        const changed =
          existing.name !== file.name ||
          Number(existing.size_bytes) !== file.size ||
          existing.mime_type !== file.mimeType ||
          existing.status !== 'active'

        if (changed) {
          run(
            `update files set name = ?, size_bytes = ?, mime_type = ?, status = 'active', deleted_at = null, updated_at = ?
             where id = ?`,
            file.name,
            file.size,
            file.mimeType || existing.mime_type,
            now,
            existing.id,
          )
          updated++
        }
      }

      for (const row of indexed) {
        if (remoteIds.has(row.provider_file_id)) continue
        if (row.status !== 'active') continue

        // Deleted (or trashed) in Drive itself. Mirror that here instead of
        // leaving a row that 404s the moment somebody clicks it.
        run("update files set status = 'trashed', deleted_at = ?, updated_at = ? where id = ?", now, now, row.id)
        removed++
      }

      summary.added += added
      summary.updated += updated
      summary.removed += removed
      summary.accounts.push({ accountId: account.id, label: account.label, added, updated, removed })

      // Quota moved too, almost certainly.
      void syncAccountQuota(account)

      if (added || updated || removed) {
        logActivity({
          userId,
          action: 'drive.synced',
          entityType: 'account',
          entityId: account.id,
          entityName: account.label,
          meta: { added, updated, removed },
        })
      }
      log.info('drive synced', { account: account.label, added, updated, removed, remote: remote.length })
    } catch (err) {
      const message = (err as Error).message.slice(0, 300)
      summary.errors.push({ accountId: account.id, label: account.label, message })
      log.warn('drive sync failed', { account: account.label, error: message })
    }
  }

  return summary
}
