import { Hono } from 'hono'
import { z } from 'zod'
import { all, get, run } from '../db/index.ts'
import { badRequest, notFound } from '../lib/errors.ts'
import { newId } from '../lib/crypto.ts'
import { sanitizeFilename } from '../lib/mime.ts'
import { requireUser } from '../middleware/auth.ts'
import { logActivity } from '../services/activity.ts'
import { listFolders, type FolderRow } from '../services/files.ts'

export const foldersRouter = new Hono()
foldersRouter.use('*', requireUser)

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: z.string().nullable().optional(),
  color: z.string().max(32).optional(),
  icon: z.string().max(32).optional(),
})

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentId: z.string().nullable().optional(),
  color: z.string().max(32).optional(),
  icon: z.string().max(32).optional(),
})

function folderRow(userId: string, id: string): FolderRow | undefined {
  return get<FolderRow>('select * from folders where id = ? and user_id = ? and deleted_at is null', id, userId)
}

/** Would moving `id` under `parentId` create a cycle? */
function isDescendant(userId: string, id: string, candidateParent: string): boolean {
  let current: string | null = candidateParent
  let guard = 0
  while (current && guard++ < 64) {
    if (current === id) return true
    current = folderRow(userId, current)?.parent_id ?? null
  }
  return false
}

foldersRouter.get('/', (c) => {
  const user = c.get('user')
  const parentId = c.req.query('parentId')
  return c.json({
    folders: listFolders(user.id, parentId === undefined || parentId === 'root' || parentId === '' ? null : parentId),
  })
})

/** Flat list for the sidebar tree — one query, assembled in memory. */
foldersRouter.get('/tree', (c) => {
  const user = c.get('user')
  const rows = all<{ id: string; name: string; parent_id: string | null; color: string; icon: string }>(
    `select d.id, d.name, d.parent_id, d.color, d.icon,
            (select count(*) from files f where f.folder_id = d.id and f.status = 'active') as file_count
     from folders d where d.user_id = ? and d.deleted_at is null order by d.name collate nocase`,
    user.id,
  )
  return c.json({ folders: rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, color: r.color, icon: r.icon })) })
})

foldersRouter.post('/', async (c) => {
  const user = c.get('user')
  const body = createSchema.parse(await c.req.json())

  if (body.parentId) {
    if (!folderRow(user.id, body.parentId)) throw badRequest('Parent folder not found.')
  }

  const id = newId()
  const now = Date.now()
  run(
    'insert into folders (id, user_id, parent_id, name, color, icon, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    user.id,
    body.parentId ?? null,
    sanitizeFilename(body.name),
    body.color ?? 'indigo',
    body.icon ?? 'folder',
    now,
    now,
  )

  logActivity({ userId: user.id, action: 'folder.created', entityType: 'folder', entityId: id, entityName: body.name })
  return c.json({ folder: { id, name: body.name, parentId: body.parentId ?? null, color: body.color ?? 'indigo', icon: body.icon ?? 'folder', updatedAt: now, fileCount: 0 } }, 201)
})

foldersRouter.patch('/:id', async (c) => {
  const user = c.get('user')
  const folder = folderRow(user.id, c.req.param('id')!)
  if (!folder) throw notFound('Folder not found.')

  const body = patchSchema.parse(await c.req.json())
  const updates: string[] = []
  const args: (string | number | null)[] = []

  if (body.name !== undefined) {
    updates.push('name = ?')
    args.push(sanitizeFilename(body.name))
  }
  if (body.color !== undefined) {
    updates.push('color = ?')
    args.push(body.color)
  }
  if (body.icon !== undefined) {
    updates.push('icon = ?')
    args.push(body.icon)
  }
  if (body.parentId !== undefined) {
    if (body.parentId) {
      if (!folderRow(user.id, body.parentId)) throw badRequest('Parent folder not found.')
      if (isDescendant(user.id, folder.id, body.parentId)) throw badRequest('A folder cannot be moved inside itself.')
    }
    updates.push('parent_id = ?')
    args.push(body.parentId)
  }

  if (!updates.length) return c.json({ ok: true })
  updates.push('updated_at = ?')
  args.push(Date.now())
  run(`update folders set ${updates.join(', ')} where id = ?`, ...args, folder.id)

  logActivity({ userId: user.id, action: 'folder.updated', entityType: 'folder', entityId: folder.id, entityName: body.name ?? folder.name })
  return c.json({ ok: true })
})

foldersRouter.delete('/:id', (c) => {
  const user = c.get('user')
  const folder = folderRow(user.id, c.req.param('id')!)
  if (!folder) throw notFound('Folder not found.')

  // Contents move up to the parent instead of being destroyed.
  const now = Date.now()
  run('update files set folder_id = ? where folder_id = ? and user_id = ?', folder.parent_id, folder.id, user.id)
  run("update folders set deleted_at = ?, updated_at = ? where id = ? and user_id = ?", now, now, folder.id, user.id)

  logActivity({ userId: user.id, action: 'folder.deleted', entityType: 'folder', entityId: folder.id, entityName: folder.name })
  return c.json({ ok: true })
})
