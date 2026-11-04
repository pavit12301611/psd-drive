import { Hono } from 'hono'
import { z } from 'zod'
import { config } from '../config.ts'
import { get, run } from '../db/index.ts'
import { newId } from '../lib/crypto.ts'
import { badRequest, notFound, tooLarge } from '../lib/errors.ts'
import { guessMime, kindOf, sanitizeFilename } from '../lib/mime.ts'
import { assertScope, requireApiKey } from '../middleware/auth.ts'
import { logActivity } from '../services/activity.ts'
import { buildProvider, listAccounts, toPublicAccount, usageByAccount } from '../services/accounts.ts'
import { queryFiles } from '../services/files.ts'
import { pickAccount } from '../services/routing.ts'
import { poolSummary, syncAccountQuota } from '../services/quota.ts'
import { parseRange } from './files.ts'

/**
 * Machine-facing API, authenticated with API keys.
 *
 *   curl -X POST "$URL/api/v1/files?name=backup.tar.gz" \
 *        -H "X-API-Key: psd_..." --data-binary @backup.tar.gz
 */
export const v1Router = new Hono()
v1Router.use('*', requireApiKey)

v1Router.get('/usage', (c) => {
  const user = c.get('user')
  const usage = usageByAccount(user.id)
  return c.json({
    pool: poolSummary(user.id),
    accounts: listAccounts(user.id).map((a) => toPublicAccount(a, usage.get(a.id) ?? 0)),
  })
})

v1Router.get('/files', (c) => {
  const user = c.get('user')
  const { files, total } = queryFiles({
    userId: user.id,
    q: c.req.query('q'),
    limit: Number(c.req.query('limit') ?? 50),
    offset: Number(c.req.query('offset') ?? 0),
    sort: 'updated',
    dir: 'desc',
  })
  return c.json({ files, total })
})

v1Router.post('/files', async (c) => {
  const user = c.get('user')
  assertScope(c, 'upload')

  const rawLength = c.req.header('content-length')
  const size = rawLength ? Number(rawLength) : NaN
  if (!Number.isFinite(size) || size <= 0) throw badRequest('Content-Length is required.')
  if (size > config.maxUploadBytes) throw tooLarge('File exceeds the instance upload limit.')

  const rawName = c.req.query('name') || c.req.header('x-file-name')
  if (!rawName) throw badRequest('Pass ?name=<filename> or the X-File-Name header.')
  const name = sanitizeFilename(decodeURIComponent(rawName))
  const mimeType = c.req.query('mime') || guessMime(name)

  const body = c.req.raw.body
  if (!body) throw badRequest('Empty body.')

  const account = pickAccount(user.id, size)
  const stored = await buildProvider(account).upload({ body, size, name, mimeType, signal: c.req.raw.signal })

  const id = newId()
  const now = Date.now()
  run(
    `insert into files (id, user_id, account_id, folder_id, provider_file_id, name, mime_type, size_bytes, status, starred, created_at, updated_at)
     values (?, ?, ?, NULL, ?, ?, ?, ?, 'active', 0, ?, ?)`,
    id,
    user.id,
    account.id,
    stored.providerFileId,
    name,
    mimeType,
    stored.size,
    now,
    now,
  )

  if (account.provider === 'google') void syncAccountQuota(account)
  logActivity({ userId: user.id, action: 'file.uploaded', entityType: 'file', entityId: id, entityName: name, meta: { via: 'api', size: stored.size } })

  return c.json(
    {
      id,
      name,
      mimeType,
      kind: kindOf(mimeType, name),
      sizeBytes: stored.size,
      account: { id: account.id, label: account.label, provider: account.provider },
      downloadUrl: `/api/v1/files/${id}/download`,
      createdAt: now,
    },
    201,
  )
})

v1Router.get('/files/:id/download', async (c) => {
  const user = c.get('user')
  assertScope(c, 'read')

  const row = get<any>(
    `select f.*, a.label as account_label from files f join accounts a on a.id = f.account_id
     where f.id = ? and f.user_id = ?`,
    c.req.param('id'),
    user.id,
  )
  if (!row) throw notFound('File not found.')

  const account = get<any>('select * from accounts where id = ?', row.account_id)
  if (!account) throw notFound('Storage account missing.')

  const size = Number(row.size_bytes)
  const range = parseRange(c.req.header('range'), size)
  if (range === 'invalid') return c.body(null, 416, { 'content-range': `bytes */${size}` })

  const result = await buildProvider(account).download(row.provider_file_id, range ?? undefined)
  const headers: Record<string, string> = {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
    'accept-ranges': 'bytes',
  }
  if (result.size) headers['content-length'] = String(result.size)
  if (result.contentRange) headers['content-range'] = result.contentRange
  return c.body(result.body as unknown as ReadableStream, result.status === 206 ? 206 : 200, headers)
})

v1Router.delete('/files/:id', async (c) => {
  const user = c.get('user')
  assertScope(c, 'delete')

  const row = get<any>('select * from files where id = ? and user_id = ?', c.req.param('id'), user.id)
  if (!row) throw notFound('File not found.')

  const account = get<any>('select * from accounts where id = ?', row.account_id)
  if (account) {
    try {
      await buildProvider(account).remove(row.provider_file_id)
    } catch {
      /* index entry still goes away */
    }
  }
  run('delete from files where id = ?', row.id)
  logActivity({ userId: user.id, action: 'file.deleted', entityType: 'file', entityId: row.id, entityName: row.name, meta: { via: 'api' } })

  return c.json({ ok: true })
})

v1Router.get('/health', (c) => c.json({ ok: true, version: '2.0.0' }))
