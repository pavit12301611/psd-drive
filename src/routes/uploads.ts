import { Hono } from 'hono'
import { config } from '../config.ts'
import { get, run } from '../db/index.ts'
import { newId } from '../lib/crypto.ts'
import { badRequest, tooLarge } from '../lib/errors.ts'
import { guessMime, kindOf, sanitizeFilename } from '../lib/mime.ts'
import { log } from '../lib/logger.ts'
import { requireUser } from '../middleware/auth.ts'
import { logActivity } from '../services/activity.ts'
import { buildProvider } from '../services/accounts.ts'
import { pickAccount } from '../services/routing.ts'
import { syncAccountQuota } from '../services/quota.ts'

export const uploadsRouter = new Hono()
uploadsRouter.use('*', requireUser)

/**
 * Single-request streaming upload.
 *
 * The client sends the raw file as the request body. We pick a destination
 * account, hand the stream to that provider, and finish. At no point is the
 * file buffered in memory or written to a temp file, so a 2 GB upload costs the
 * server a few kilobytes of heap and roughly constant memory.
 */
uploadsRouter.post('/', async (c) => {
  const user = c.get('user')

  const rawLength = c.req.header('content-length')
  const size = rawLength ? Number(rawLength) : NaN
  if (!Number.isFinite(size) || size <= 0) {
    throw badRequest('A Content-Length header is required to route the upload.')
  }
  if (size > config.maxUploadBytes) {
    throw tooLarge(`Files larger than ${Math.round(config.maxUploadBytes / 1024 ** 3)} GB are not supported.`)
  }

  const rawName = c.req.query('name') || c.req.header('x-file-name')
  if (!rawName) throw badRequest('A file name is required.')
  const name = sanitizeFilename(decodeURIComponent(rawName))
  const mimeType = c.req.query('mime') || c.req.header('x-file-mime') || guessMime(name)

  const folderId = c.req.query('folderId')
  if (folderId && folderId !== 'root') {
    const folder = get<{ id: string }>(
      'select id from folders where id = ? and user_id = ? and deleted_at is null',
      folderId,
      user.id,
    )
    if (!folder) throw badRequest('Folder not found.')
  }

  const body = c.req.raw.body
  if (!body) throw badRequest('Empty upload body.')

  // Pick the destination *before* touching the stream so a "no space" error is
  // a clean 507 instead of a half-consumed request.
  const account = pickAccount(user.id, size)
  const provider = buildProvider(account)
  const startedAt = Date.now()

  const stored = await provider.upload({
    body,
    size,
    name,
    mimeType,
    signal: c.req.raw.signal,
  })

  const id = newId()
  const now = Date.now()
  run(
    `insert into files (id, user_id, account_id, folder_id, provider_file_id, name, mime_type, size_bytes, status, starred, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)`,
    id,
    user.id,
    account.id,
    folderId && folderId !== 'root' ? folderId : null,
    stored.providerFileId,
    name,
    mimeType,
    stored.size,
    now,
    now,
  )

  logActivity({
    userId: user.id,
    action: 'file.uploaded',
    entityType: 'file',
    entityId: id,
    entityName: name,
    meta: { size: stored.size, account: account.label, ms: Date.now() - startedAt },
  })

  // Google reports quota out of band; refresh in the background so the
  // dashboard is accurate without delaying this response.
  if (account.provider === 'google') void syncAccountQuota(account)

  log.info('upload stored', { name, size: stored.size, account: account.label, ms: Date.now() - startedAt })

  return c.json(
    {
      file: {
        id,
        name,
        mimeType,
        kind: kindOf(mimeType, name),
        sizeBytes: stored.size,
        folderId: folderId && folderId !== 'root' ? folderId : null,
        accountId: account.id,
        accountLabel: account.label,
        provider: account.provider,
        starred: false,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        previewable: true,
        shared: false,
      },
      account: { id: account.id, label: account.label, provider: account.provider },
      elapsedMs: Date.now() - startedAt,
    },
    201,
  )
})
