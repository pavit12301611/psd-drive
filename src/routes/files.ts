import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { all, get, run, tx } from '../db/index.ts'
import { badRequest, notFound } from '../lib/errors.ts'
import { inlineMime, sanitizeFilename } from '../lib/mime.ts'
import { requireUser } from '../middleware/auth.ts'
import { logActivity } from '../services/activity.ts'
import { buildProvider } from '../services/accounts.ts'
import { folderPath, getFileWithAccount, getFileRow, listFolders, queryFiles } from '../services/files.ts'
import { syncDrive } from '../services/sync.ts'
import { getAccount } from '../services/accounts.ts'

export const filesRouter = new Hono()
filesRouter.use('*', requireUser)

/* ------------------------------- helpers ------------------------------- */

export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'

  const [, startRaw, endRaw] = match
  if (!startRaw && !endRaw) return 'invalid'
  if (!startRaw) {
    // suffix range: last N bytes
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(startRaw)
  const end = endRaw ? Number(endRaw) : size - 1
  if (!Number.isFinite(start) || start >= size || end < start) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

function disposition(kind: 'inline' | 'attachment', name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

async function streamFile(c: Context, mode: 'inline' | 'attachment') {
  const user = c.get('user')
  const file = getFileWithAccount(user.id, c.req.param('id')!)
  if (!file) throw notFound('That file no longer exists.')
  if (file.status === 'purged') throw notFound('That file was permanently deleted.')

  const account = getAccount(user.id, file.account_id)
  if (!account) throw notFound('The storage account for this file was removed.')

  const size = Number(file.size_bytes)
  const range = parseRange(c.req.header('range'), size)
  if (range === 'invalid') {
    return c.body(null, 416, { 'content-range': `bytes */${size}` })
  }

  const provider = buildProvider(account)
  const result = await provider.download(file.provider_file_id, range ?? undefined)

  const headers: Record<string, string> = {
    'accept-ranges': 'bytes',
    'content-type': mode === 'attachment' ? 'application/octet-stream' : inlineMime(file.mime_type, file.name),
    'content-disposition': disposition(mode, file.name),
    // Private + long-lived: a file's bytes never change under a given id.
    'cache-control': 'private, max-age=86400, immutable',
    'x-content-type-options': 'nosniff',
  }
  if (result.size) headers['content-length'] = String(result.size)
  if (result.contentRange) headers['content-range'] = result.contentRange
  if (result.etag) headers.etag = result.etag

  return c.body(result.body as unknown as ReadableStream, result.status === 206 ? 206 : 200, headers)
}

/* -------------------------------- routes -------------------------------- */

/**
 * Sync Drive: pull changes made inside Google Drive into this index.
 * Metadata only — no file bytes move.
 */
filesRouter.post('/sync', async (c) => {
  const user = c.get('user')
  const summary = await syncDrive(user.id)
  return c.json(summary)
})

filesRouter.get('/content/:id', (c) => streamFile(c, 'inline'))
filesRouter.get('/download/:id', (c) => streamFile(c, 'attachment'))

filesRouter.get('/', (c) => {
  const user = c.get('user')
  const view = (c.req.query('view') ?? 'all') as 'all' | 'recent' | 'starred' | 'trash' | 'shared'
  const folderId = c.req.query('folderId')
  const q = c.req.query('q')

  const { files, total } = queryFiles({
    userId: user.id,
    view,
    folderId: folderId === undefined ? undefined : folderId === 'root' || folderId === '' ? null : folderId,
    q,
    kind: c.req.query('kind') || undefined,
    accountId: c.req.query('accountId') || undefined,
    minSize: c.req.query('minSize') ? Number(c.req.query('minSize')) : undefined,
    maxSize: c.req.query('maxSize') ? Number(c.req.query('maxSize')) : undefined,
    after: c.req.query('after') ? Number(c.req.query('after')) : undefined,
    before: c.req.query('before') ? Number(c.req.query('before')) : undefined,
    sort: (c.req.query('sort') as 'name' | 'size' | 'updated' | 'kind') || undefined,
    dir: (c.req.query('dir') as 'asc' | 'desc') || undefined,
    limit: Number(c.req.query('limit') ?? 60),
    offset: Number(c.req.query('offset') ?? 0),
  })

  // Folders are only meaningful when browsing a real location, not searching.
  const showFolders = !q && (view === 'all' || view === 'recent')
  const folders = showFolders ? listFolders(user.id, folderId === undefined || folderId === 'root' || folderId === '' ? null : folderId) : []

  return c.json({
    files,
    folders,
    total,
    breadcrumb: folderId && folderId !== 'root' ? folderPath(user.id, folderId) : [],
  })
})

filesRouter.get('/:id', (c) => {
  const user = c.get('user')
  const file = getFileWithAccount(user.id, c.req.param('id'))
  if (!file) throw notFound('File not found.')

  const share = get<{ token: string; expires_at: number | null; download_count: number; view_count: number }>(
    'select token, expires_at, download_count, view_count from shares where file_id = ? and enabled = 1 order by created_at desc limit 1',
    file.id,
  )

  return c.json({
    file: {
      id: file.id,
      name: file.name,
      mimeType: file.mime_type,
      sizeBytes: Number(file.size_bytes),
      kind: inlineMime(file.mime_type, file.name),
      folderId: file.folder_id,
      accountId: file.account_id,
      accountLabel: file.account_label,
      provider: file.provider,
      starred: Boolean(file.starred),
      status: file.status,
      createdAt: file.created_at,
      updatedAt: file.updated_at,
    },
    share: share
      ? {
          token: share.token,
          expiresAt: share.expires_at,
          url: `/p/${share.token}`,
          downloadCount: share.download_count,
          viewCount: share.view_count,
        }
      : null,
  })
})

const patchSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  folderId: z.string().nullable().optional(),
  starred: z.boolean().optional(),
})

filesRouter.patch('/:id', async (c) => {
  const user = c.get('user')
  const file = getFileWithAccount(user.id, c.req.param('id')!)
  if (!file) throw notFound('File not found.')

  const body = patchSchema.parse(await c.req.json())
  const updates: string[] = []
  const args: (string | number | null)[] = []

  if (body.name !== undefined) {
    if (file.name !== body.name) {
      const account = getAccount(user.id, file.account_id)
      if (account?.provider === 'google') {
        // Best-effort: keep the real Drive file in sync. A failure here must not
        // block the rename in our index.
        try {
          await buildProvider(account).rename(file.provider_file_id, body.name)
        } catch {
          /* ignore */
        }
      }
    }
    updates.push('name = ?')
    args.push(sanitizeFilename(body.name))
  }

  if (body.folderId !== undefined) {
    if (body.folderId) {
      const folder = get<{ id: string }>(
        'select id from folders where id = ? and user_id = ? and deleted_at is null',
        body.folderId,
        user.id,
      )
      if (!folder) throw badRequest('Destination folder not found.')
    }
    updates.push('folder_id = ?')
    args.push(body.folderId)
  }

  if (body.starred !== undefined) {
    updates.push('starred = ?')
    args.push(body.starred ? 1 : 0)
  }

  if (!updates.length) return c.json({ ok: true })

  updates.push('updated_at = ?')
  args.push(Date.now())
  run(`update files set ${updates.join(', ')} where id = ?`, ...args, file.id)

  logActivity({
    userId: user.id,
    action: body.name ? 'file.renamed' : body.folderId !== undefined ? 'file.moved' : 'file.starred',
    entityType: 'file',
    entityId: file.id,
    entityName: body.name ?? file.name,
  })

  return c.json({ ok: true })
})

const bulkSchema = z.object({
  ids: z.array(z.string()).min(1).max(500),
  action: z.enum(['trash', 'restore', 'purge', 'star', 'unstar', 'move']),
  folderId: z.string().nullable().optional(),
})

filesRouter.post('/bulk', async (c) => {
  const user = c.get('user')
  const body = bulkSchema.parse(await c.req.json())
  const placeholders = body.ids.map(() => '?').join(',')
  const now = Date.now()

  if (body.action === 'trash') {
    const res = run(
      `update files set status = 'trashed', deleted_at = ?, updated_at = ? where user_id = ? and id in (${placeholders})`,
      now,
      now,
      user.id,
      ...body.ids,
    )
    run(`update shares set enabled = 0 where file_id in (${placeholders})`, ...body.ids)
    logActivity({ userId: user.id, action: 'file.trashed', entityType: 'file', meta: { count: res.changes } })
    return c.json({ affected: res.changes })
  }

  if (body.action === 'restore') {
    const res = run(
      `update files set status = 'active', deleted_at = null, updated_at = ? where user_id = ? and id in (${placeholders})`,
      now,
      user.id,
      ...body.ids,
    )
    logActivity({ userId: user.id, action: 'file.restored', entityType: 'file', meta: { count: res.changes } })
    return c.json({ affected: res.changes })
  }

  if (body.action === 'star' || body.action === 'unstar') {
    const res = run(
      `update files set starred = ?, updated_at = ? where user_id = ? and id in (${placeholders})`,
      body.action === 'star' ? 1 : 0,
      now,
      user.id,
      ...body.ids,
    )
    return c.json({ affected: res.changes })
  }

  if (body.action === 'move') {
    if (body.folderId) {
      const folder = get<{ id: string }>(
        'select id from folders where id = ? and user_id = ? and deleted_at is null',
        body.folderId,
        user.id,
      )
      if (!folder) throw badRequest('Destination folder not found.')
    }
    const res = run(
      `update files set folder_id = ?, updated_at = ? where user_id = ? and id in (${placeholders})`,
      body.folderId ?? null,
      now,
      user.id,
      ...body.ids,
    )
    logActivity({ userId: user.id, action: 'file.moved', entityType: 'file', meta: { count: res.changes } })
    return c.json({ affected: res.changes })
  }

  // Purge: delete the bytes first, then the row. A provider failure keeps the
  // row so the file is retryable rather than a silent orphan.
  const targets = all<{ id: string; account_id: string; provider_file_id: string; name: string }>(
    `select id, account_id, provider_file_id, name from files where user_id = ? and id in (${placeholders})`,
    user.id,
    ...body.ids,
  )

  const byAccount = new Map<string, typeof targets>()
  for (const row of targets) {
    const list = byAccount.get(row.account_id) ?? []
    list.push(row)
    byAccount.set(row.account_id, list)
  }

  let deleted = 0
  for (const [accountId, rows] of byAccount) {
    const account = getAccount(user.id, accountId)
    if (!account) continue
    const provider = buildProvider(account)
    for (const row of rows) {
      try {
        await provider.remove(row.provider_file_id)
      } catch {
        /* still drop the index entry — the bytes may already be gone upstream */
      }
      tx(() => run('delete from files where id = ?', row.id))
      deleted++
    }
  }

  logActivity({ userId: user.id, action: 'file.purged', entityType: 'file', meta: { count: deleted } })
  return c.json({ affected: deleted })
})

filesRouter.post('/empty-trash', async (c) => {
  const user = c.get('user')
  const trashed = all<{ id: string }>("select id from files where user_id = ? and status = 'trashed'", user.id)
  if (!trashed.length) return c.json({ affected: 0 })

  const results = await Promise.all(
    trashed.map(async (row) => {
      const file = getFileRow(user.id, row.id)
      if (!file) return false
      const account = getAccount(user.id, file.account_id)
      if (account) {
        try {
          await buildProvider(account).remove(file.provider_file_id)
        } catch {
          /* the bytes may already be gone upstream */
        }
      }
      run('delete from files where id = ?', row.id)
      return true
    }),
  )

  const affected = results.filter(Boolean).length
  logActivity({ userId: user.id, action: 'trash.emptied', entityType: 'file', meta: { count: affected } })
  return c.json({ affected })
})
