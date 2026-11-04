import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { config } from '../config.ts'
import { all, get, run } from '../db/index.ts'
import { newId, randomToken } from '../lib/crypto.ts'
import { badRequest, notFound } from '../lib/errors.ts'
import { inlineMime, kindOf } from '../lib/mime.ts'
import { rateLimit } from '../lib/ratelimit.ts'
import { requireUser } from '../middleware/auth.ts'
import { logActivity } from '../services/activity.ts'
import { buildProvider } from '../services/accounts.ts'
import { parseRange } from './files.ts'

export const sharesRouter = new Hono()

type ShareRow = {
  id: string
  user_id: string
  file_id: string
  token: string
  expires_at: number | null
  download_count: number
  view_count: number
  enabled: number
  created_at: number
}

/* ----------------------------- authenticated ----------------------------- */

sharesRouter.get('/', requireUser, (c) => {
  const user = c.get('user')
  const rows = all<ShareRow & { name: string; mime_type: string; size_bytes: number; account_label: string }>(
    `select s.*, f.name, f.mime_type, f.size_bytes, a.label as account_label
     from shares s
     join files f on f.id = s.file_id
     join accounts a on a.id = f.account_id
     where s.user_id = ? and s.enabled = 1
     order by s.created_at desc`,
    user.id,
  )

  return c.json({
    shares: rows.map((row) => ({
      id: row.id,
      token: row.token,
      fileId: row.file_id,
      fileName: row.name,
      mimeType: row.mime_type,
      kind: kindOf(row.mime_type, row.name),
      sizeBytes: Number(row.size_bytes),
      accountLabel: row.account_label,
      url: publicUrl(c, row.token),
      expiresAt: row.expires_at,
      downloads: row.download_count,
      views: row.view_count,
      createdAt: row.created_at,
    })),
  })
})

/**
 * Share links must be correct behind any host, port or reverse proxy, not just
 * the one in APP_URL — so prefer the origin the request actually arrived on.
 */
export function requestOrigin(c: Context): string {
  const forwardedHost = c.req.header('x-forwarded-host')
  const host = forwardedHost || c.req.header('host')
  if (!host) return config.appUrl
  const proto =
    c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() ||
    (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
  return `${proto}://${host}`
}

function publicUrl(c: Context, token: string): string {
  return `${requestOrigin(c)}/p/${token}`
}

sharesRouter.post('/', requireUser, async (c) => {
  const user = c.get('user')
  const body = z
    .object({
      fileId: z.string(),
      expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
    })
    .parse(await c.req.json())

  const file = get<{ id: string; name: string }>(
    'select id, name from files where id = ? and user_id = ?',
    body.fileId,
    user.id,
  )
  if (!file) throw notFound('File not found.')

  const existing = get<ShareRow>(
    'select * from shares where file_id = ? and enabled = 1 order by created_at desc limit 1',
    file.id,
  )
  if (existing) {
    return c.json({ share: { id: existing.id, token: existing.token, url: publicUrl(c, existing.token), expiresAt: existing.expires_at } })
  }

  const token = randomToken(16)
  const id = newId()
  run(
    'insert into shares (id, user_id, file_id, token, expires_at, download_count, view_count, enabled, created_at) values (?, ?, ?, ?, ?, 0, 0, 1, ?)',
    id,
    user.id,
    file.id,
    token,
    body.expiresInDays ? Date.now() + body.expiresInDays * 86_400_000 : null,
    Date.now(),
  )

  logActivity({ userId: user.id, action: 'share.created', entityType: 'share', entityId: id, entityName: file.name })
  return c.json({ share: { id, token, url: publicUrl(c, token), expiresAt: body.expiresInDays ? Date.now() + body.expiresInDays * 86_400_000 : null } }, 201)
})

sharesRouter.delete('/:id', requireUser, (c) => {
  const user = c.get('user')
  const share = get<ShareRow>('select * from shares where id = ? and user_id = ?', c.req.param('id'), user.id)
  if (!share) throw notFound('Share not found.')

  run('update shares set enabled = 0 where id = ?', share.id)
  logActivity({ userId: user.id, action: 'share.revoked', entityType: 'share', entityId: share.id })
  return c.json({ ok: true })
})

/* -------------------------------- public -------------------------------- */

export const publicRouter = new Hono()

function resolveShare(token: string) {
  const share = get<ShareRow & { name: string; mime_type: string; size_bytes: number; status: string; account_id: string; provider_file_id: string }>(
    `select s.*, f.name, f.mime_type, f.size_bytes, f.status, f.account_id, f.provider_file_id
     from shares s join files f on f.id = s.file_id
     where s.token = ? and s.enabled = 1`,
    token,
  )
  if (!share) throw notFound('This link is invalid or has been revoked.')
  if (share.expires_at && share.expires_at < Date.now()) throw notFound('This link has expired.')
  if (share.status !== 'active') throw notFound('The shared file is no longer available.')
  return share
}

publicRouter.get('/:token', (c) => {
  const token = c.req.param('token')
  rateLimit(`public:${c.req.header('x-forwarded-for') ?? 'local'}`, 240, 60_000)

  const share = resolveShare(token)
  run('update shares set view_count = view_count + 1 where id = ?', share.id)

  const account = get<{ id: string; user_id: string; provider: string }>('select id, user_id, provider from accounts where id = ?', share.account_id)

  return c.json({
    share: {
      token,
      fileName: share.name,
      mimeType: share.mime_type,
      kind: kindOf(share.mime_type, share.name),
      inlineType: inlineMime(share.mime_type, share.name),
      sizeBytes: Number(share.size_bytes),
      provider: account?.provider ?? 'unknown',
      expiresAt: share.expires_at,
      downloads: share.download_count,
      views: share.view_count,
      createdAt: share.created_at,
      downloadUrl: `/api/public/${token}/download`,
      contentUrl: `/api/public/${token}/content`,
    },
  })
})

async function streamPublic(c: Context, mode: 'inline' | 'attachment') {
  const token = c.req.param('token')!
  const share = resolveShare(token)

  const accountRow = get<any>('select * from accounts where id = ?', share.account_id)
  if (!accountRow) throw notFound('The storage account for this file was removed.')

  const size = Number(share.size_bytes)
  const range = parseRange(c.req.header('range'), size)
  if (range === 'invalid') return c.body(null, 416, { 'content-range': `bytes */${size}` })

  const provider = buildProvider(accountRow)
  const result = await provider.download(share.provider_file_id, range ?? undefined)

  if (mode === 'attachment') {
    run('update shares set download_count = download_count + 1 where id = ?', share.id)
  }

  const headers: Record<string, string> = {
    'accept-ranges': 'bytes',
    'content-type': mode === 'attachment' ? 'application/octet-stream' : inlineMime(share.mime_type, share.name),
    'content-disposition': `${mode}; filename*=UTF-8''${encodeURIComponent(share.name)}`,
    'cache-control': 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  }
  if (result.size) headers['content-length'] = String(result.size)
  if (result.contentRange) headers['content-range'] = result.contentRange

  return c.body(result.body as unknown as ReadableStream, result.status === 206 ? 206 : 200, headers)
}

publicRouter.get('/:token/content', (c) => streamPublic(c, 'inline'))
publicRouter.get('/:token/download', async (c) => {
  rateLimit(`public-dl:${c.req.header('x-forwarded-for') ?? 'local'}`, 120, 60_000)
  return streamPublic(c, 'attachment')
})

/** Resolve a public token to a raw provider URL — used by the embed viewer. */
publicRouter.get('/:token/meta', (c) => {
  const share = resolveShare(c.req.param('token')!)
  return c.json({
    fileName: share.name,
    mimeType: share.mime_type,
    sizeBytes: Number(share.size_bytes),
    expiresAt: share.expires_at,
  })
})

export { badRequest }
