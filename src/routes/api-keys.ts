import { Hono } from 'hono'
import { z } from 'zod'
import { all, get, run } from '../db/index.ts'
import { newId, randomToken, sha256 } from '../lib/crypto.ts'
import { notFound } from '../lib/errors.ts'
import { requireUser } from '../middleware/auth.ts'
import { logActivity } from '../services/activity.ts'

export const apiKeysRouter = new Hono()
apiKeysRouter.use('*', requireUser)

apiKeysRouter.get('/', (c) => {
  const user = c.get('user')
  const rows = all<{
    id: string
    name: string
    prefix: string
    scopes: string
    last_used_at: number | null
    revoked_at: number | null
    created_at: number
  }>('select id, name, prefix, scopes, last_used_at, revoked_at, created_at from api_keys where user_id = ? order by created_at desc', user.id)

  return c.json({
    keys: rows.map((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      scopes: row.scopes.split(',').filter(Boolean),
      lastUsedAt: row.last_used_at,
      revoked: Boolean(row.revoked_at),
      createdAt: row.created_at,
    })),
  })
})

apiKeysRouter.post('/', async (c) => {
  const user = c.get('user')
  const body = z
    .object({
      name: z.string().trim().min(1).max(80),
      scopes: z.array(z.enum(['upload', 'read', 'delete'])).min(1).default(['upload', 'read']),
    })
    .parse(await c.req.json())

  // Shown exactly once; only the SHA-256 hash is stored.
  const secret = `psd_${randomToken(24)}`
  const id = newId()

  run(
    'insert into api_keys (id, user_id, name, prefix, key_hash, scopes, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    id,
    user.id,
    body.name,
    secret.slice(0, 12),
    sha256(secret),
    body.scopes.join(','),
    Date.now(),
  )

  logActivity({ userId: user.id, action: 'api_key.created', entityType: 'api_key', entityId: id, entityName: body.name })
  return c.json({ key: { id, name: body.name, secret, scopes: body.scopes, prefix: secret.slice(0, 12) } }, 201)
})

apiKeysRouter.delete('/:id', (c) => {
  const user = c.get('user')
  const key = get<{ id: string; name: string }>('select id, name from api_keys where id = ? and user_id = ?', c.req.param('id'), user.id)
  if (!key) throw notFound('API key not found.')

  run('update api_keys set revoked_at = ? where id = ?', Date.now(), key.id)
  logActivity({ userId: user.id, action: 'api_key.revoked', entityType: 'api_key', entityId: key.id, entityName: key.name })
  return c.json({ ok: true })
})
