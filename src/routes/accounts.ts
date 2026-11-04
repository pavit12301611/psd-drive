import { Hono } from 'hono'
import { z } from 'zod'
import { all, get, run } from '../db/index.ts'
import { encrypt, newId } from '../lib/crypto.ts'
import { badRequest, notFound } from '../lib/errors.ts'
import { signRequest } from '../lib/sigv4.ts'
import { requireUser } from '../middleware/auth.ts'
import { logActivity } from '../services/activity.ts'
import {
  buildProvider,
  listAccounts,
  toPublicAccount,
  usageByAccount,
  type AccountRow,
} from '../services/accounts.ts'
import { getPolicy, setPolicy } from '../services/routing.ts'
import { poolSummary, refreshAllQuotas, syncAccountQuota } from '../services/quota.ts'

export const accountsRouter = new Hono()
accountsRouter.use('*', requireUser)

const GB = 1024 ** 3

const s3Schema = z.object({
  label: z.string().trim().min(1).max(80),
  bucket: z.string().trim().min(1).max(120),
  region: z.string().trim().min(1).max(64).default('auto'),
  endpoint: z.string().trim().url().optional().or(z.literal('')),
  accessKeyId: z.string().trim().min(1).max(200),
  secretAccessKey: z.string().trim().min(1).max(400),
  prefix: z.string().trim().max(120).default('psdrive'),
  forcePathStyle: z.boolean().default(false),
  quotaGb: z.number().min(0).max(1_000_000).optional(),
})

const localSchema = z.object({
  label: z.string().trim().min(1).max(80),
  quotaGb: z.number().min(0).max(1_000_000).optional(),
})

/** HEAD the bucket to prove the credentials work before we save them. */
async function probeS3(cfg: {
  bucket: string
  region: string
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
}): Promise<void> {
  const signed = signRequest({ config: { ...cfg, prefix: '' }, method: 'HEAD' })
  let res: Response
  try {
    res = await fetch(signed.url, { method: 'HEAD', headers: signed.headers, signal: AbortSignal.timeout(12_000) })
  } catch (err) {
    throw badRequest(`Could not reach that endpoint: ${(err as Error).message}`)
  }
  if (res.status === 200) return
  if (res.status === 403) throw badRequest('Credentials were rejected (403). Check the access key, secret and region.')
  if (res.status === 404) throw badRequest('Bucket not found (404). Check the bucket name and endpoint.')
  throw badRequest(`Bucket check failed with HTTP ${res.status}.`)
}

accountsRouter.get('/', (c) => {
  const user = c.get('user')
  const usage = usageByAccount(user.id)
  return c.json({
    accounts: listAccounts(user.id).map((a) => toPublicAccount(a, usage.get(a.id) ?? 0)),
    pool: poolSummary(user.id),
  })
})

accountsRouter.post('/s3', async (c) => {
  const user = c.get('user')
  const body = s3Schema.parse(await c.req.json())
  const endpoint = body.endpoint || undefined

  await probeS3({
    bucket: body.bucket,
    region: body.region,
    endpoint,
    accessKeyId: body.accessKeyId,
    secretAccessKey: body.secretAccessKey,
    forcePathStyle: body.forcePathStyle,
  })

  const id = newId()
  const now = Date.now()
  const quota = body.quotaGb ? Math.round(body.quotaGb * GB) : null

  run(
    `insert into accounts (id, user_id, provider, label, provider_account_id, config, total_bytes, used_bytes,
       available_bytes, quota_synced_at, priority, enabled, status, created_at, updated_at)
     values (?, ?, 's3', ?, ?, ?, ?, 0, ?, ?, ?, 1, 'connected', ?, ?)`,
    id,
    user.id,
    body.label,
    `${body.bucket}:${body.prefix || ''}`,
    JSON.stringify({
      bucket: body.bucket,
      region: body.region,
      endpoint: endpoint ?? null,
      accessKeyId: encrypt(body.accessKeyId),
      secretAccessKey: encrypt(body.secretAccessKey),
      forcePathStyle: body.forcePathStyle,
      prefix: body.prefix,
    }),
    quota,
    quota,
    now,
    listAccounts(user.id).length,
    now,
    now,
  )

  logActivity({ userId: user.id, action: 'account.connected', entityType: 'account', entityId: id, entityName: body.label, meta: { provider: 's3' } })
  return c.json({ id }, 201)
})

accountsRouter.post('/local', async (c) => {
  const user = c.get('user')
  const body = localSchema.parse(await c.req.json())

  const id = newId()
  const now = Date.now()
  const quota = body.quotaGb ? Math.round(body.quotaGb * GB) : null

  run(
    `insert into accounts (id, user_id, provider, label, provider_account_id, config, total_bytes, used_bytes,
       available_bytes, quota_synced_at, priority, enabled, status, created_at, updated_at)
     values (?, ?, 'local', ?, ?, '{}', ?, 0, ?, ?, ?, 1, 'connected', ?, ?)`,
    id,
    user.id,
    body.label,
    newId(),
    quota,
    quota,
    now,
    listAccounts(user.id).length,
    now,
    now,
  )

  logActivity({ userId: user.id, action: 'account.connected', entityType: 'account', entityId: id, entityName: body.label, meta: { provider: 'local' } })
  return c.json({ id }, 201)
})

accountsRouter.patch('/:id', async (c) => {
  const user = c.get('user')
  const account = get<AccountRow>('select * from accounts where id = ? and user_id = ?', c.req.param('id'), user.id)
  if (!account) throw notFound('Account not found.')

  const body = z
    .object({
      label: z.string().trim().min(1).max(80).optional(),
      enabled: z.boolean().optional(),
      priority: z.number().int().min(0).max(1000).optional(),
      quotaGb: z.number().min(0).max(1_000_000).nullable().optional(),
    })
    .parse(await c.req.json())

  const updates: string[] = []
  const args: (string | number | null)[] = []

  if (body.label) {
    updates.push('label = ?')
    args.push(body.label)
  }
  if (body.enabled !== undefined) {
    updates.push('enabled = ?')
    args.push(body.enabled ? 1 : 0)
  }
  if (body.priority !== undefined) {
    updates.push('priority = ?')
    args.push(body.priority)
  }
  if (body.quotaGb !== undefined) {
    const quota = body.quotaGb === null ? null : Math.round(body.quotaGb * GB)
    updates.push('total_bytes = ?', 'available_bytes = ?')
    args.push(quota, quota)
  }

  if (!updates.length) return c.json({ ok: true })
  updates.push('updated_at = ?')
  args.push(Date.now())
  run(`update accounts set ${updates.join(', ')} where id = ?`, ...args, account.id)

  return c.json({ ok: true })
})

accountsRouter.post('/:id/sync', async (c) => {
  const user = c.get('user')
  const account = get<AccountRow>('select * from accounts where id = ? and user_id = ?', c.req.param('id'), user.id)
  if (!account) throw notFound('Account not found.')

  await syncAccountQuota(account)
  const fresh = get<AccountRow>('select * from accounts where id = ?', account.id)!
  return c.json({ account: toPublicAccount(fresh, usageByAccount(user.id).get(fresh.id) ?? 0) })
})

accountsRouter.post('/sync-all', async (c) => {
  const user = c.get('user')
  await refreshAllQuotas(user.id)
  return c.json({ pool: poolSummary(user.id) })
})

accountsRouter.delete('/:id', (c) => {
  const user = c.get('user')
  const account = get<AccountRow>('select * from accounts where id = ? and user_id = ?', c.req.param('id'), user.id)
  if (!account) throw notFound('Account not found.')

  const fileCount = Number(
    get<{ c: number }>('select count(*) as c from files where account_id = ?', account.id)?.c ?? 0,
  )

  // Deleting an account drops its index entries. We deliberately do not delete
  // the user's bytes upstream — that would be a destructive surprise.
  run('delete from accounts where id = ?', account.id)
  logActivity({
    userId: user.id,
    action: 'account.disconnected',
    entityType: 'account',
    entityId: account.id,
    entityName: account.label,
    meta: { files: fileCount },
  })

  return c.json({ ok: true, filesRemoved: fileCount })
})

accountsRouter.get('/routing/policy', (c) => {
  const user = c.get('user')
  return c.json({ policy: getPolicy(user.id) })
})

accountsRouter.put('/routing/policy', async (c) => {
  const user = c.get('user')
  const body = z
    .object({
      mode: z.enum(['most_available', 'round_robin', 'priority']),
      order: z.array(z.string()).max(100).default([]),
    })
    .parse(await c.req.json())

  return c.json({ policy: setPolicy(user.id, body) })
})

/** Round-trip check for an existing S3 account. */
accountsRouter.post('/:id/test', async (c) => {
  const user = c.get('user')
  const account = get<AccountRow>('select * from accounts where id = ? and user_id = ?', c.req.param('id'), user.id)
  if (!account) throw notFound('Account not found.')

  try {
    const quota = await buildProvider(account).quota()
    run('update accounts set status = ?, last_error = NULL, updated_at = ? where id = ?', 'connected', Date.now(), account.id)
    return c.json({ ok: true, quota })
  } catch (err) {
    const message = (err as Error).message
    run('update accounts set status = ?, last_error = ?, updated_at = ? where id = ?', 'error', message, Date.now(), account.id)
    return c.json({ ok: false, error: message }, 400)
  }
})

/** Used by the settings screen to show which providers can be connected. */
accountsRouter.get('/providers', (c) => {
  const user = c.get('user')
  const counts = all<{ provider: string; c: number }>(
    'select provider, count(*) as c from accounts where user_id = ? group by provider',
    user.id,
  )
  return c.json({ providers: counts })
})
