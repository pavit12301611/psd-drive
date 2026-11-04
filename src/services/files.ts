import { all, get, pluck } from '../db/index.ts'
import { isPreviewable, kindOf } from '../lib/mime.ts'

export type FileRow = {
  id: string
  user_id: string
  account_id: string
  folder_id: string | null
  provider_file_id: string
  name: string
  mime_type: string
  size_bytes: number
  checksum: string | null
  status: string
  starred: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export type FolderRow = {
  id: string
  user_id: string
  parent_id: string | null
  name: string
  color: string
  icon: string
  created_at: number
  updated_at: number
  deleted_at: number | null
}

export type PublicFile = {
  id: string
  name: string
  mimeType: string
  kind: string
  sizeBytes: number
  folderId: string | null
  accountId: string
  accountLabel: string
  provider: string
  starred: boolean
  status: string
  createdAt: number
  updatedAt: number
  previewable: boolean
  shared: boolean
}

export type PublicFolder = {
  id: string
  name: string
  parentId: string | null
  color: string
  icon: string
  updatedAt: number
  fileCount: number
}

type FileQuery = {
  userId: string
  folderId?: string | null
  q?: string
  kind?: string
  accountId?: string
  starred?: boolean
  view?: 'all' | 'recent' | 'starred' | 'trash' | 'shared'
  sort?: 'name' | 'size' | 'updated' | 'kind'
  dir?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

const KINDS_BY_FILTER: Record<string, string[]> = {
  image: ['image/'],
  video: ['video/'],
  audio: ['audio/'],
  pdf: ['application/pdf'],
  archive: ['application/zip', 'application/vnd.rar', 'application/x-7z-compressed', 'application/x-tar', 'application/gzip'],
}

/** Escape user input into a safe FTS5 prefix query. */
function ftsQuery(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu)
  if (!tokens || tokens.length === 0) return null
  return tokens.map((t) => `"${t}"*`).join(' ')
}

export function queryFiles(params: FileQuery): { files: PublicFile[]; total: number } {
  const limit = Math.min(Math.max(params.limit ?? 60, 1), 200)
  const offset = Math.max(params.offset ?? 0, 0)
  const view = params.view ?? 'all'

  const where: string[] = ['f.user_id = ?']
  const args: (string | number)[] = [params.userId]

  where.push(view === 'trash' ? "f.status = 'trashed'" : "f.status = 'active'")

  if (params.folderId !== undefined) {
    if (params.folderId === null) where.push('f.folder_id is null')
    else {
      where.push('f.folder_id = ?')
      args.push(params.folderId)
    }
  }

  if (params.starred || view === 'starred') where.push('f.starred = 1')

  if (params.accountId) {
    where.push('f.account_id = ?')
    args.push(params.accountId)
  } else if (view === 'shared') {
    where.push('exists (select 1 from shares s where s.file_id = f.id and s.enabled = 1)')
  }

  if (params.kind && KINDS_BY_FILTER[params.kind]) {
    const prefixes = KINDS_BY_FILTER[params.kind]
    where.push(`(${prefixes.map(() => 'f.mime_type like ?').join(' or ')})`)
    for (const p of prefixes) args.push(`${p}%`)
  }

  let from = 'files f'
  let orderBy: string
  let searchJoin = ''

  if (params.q?.trim()) {
    const match = ftsQuery(params.q)
    if (match) {
      searchJoin = ' join files_fts on files_fts.rowid = f.rowid'
      where.push('files_fts match ?')
      args.push(match)
      orderBy = 'order by rank'
    } else {
      where.push('f.name like ?')
      args.push(`%${params.q.trim()}%`)
      orderBy = sortClause(params.sort, params.dir)
    }
  } else {
    orderBy = sortClause(params.sort, params.dir)
  }

  const total = Number(
    pluck<number>(`select count(*) as c from ${from}${searchJoin} where ${where.join(' and ')}`, ...args) ?? 0,
  )

  const rows = all<FileRow & { account_label: string; provider: string; has_share: number }>(
    `select f.*, a.label as account_label, a.provider,
            exists (select 1 from shares s where s.file_id = f.id and s.enabled = 1) as has_share
     from ${from}${searchJoin}
     join accounts a on a.id = f.account_id
     where ${where.join(' and ')}
     ${orderBy}
     limit ? offset ?`,
    ...args,
    limit,
    offset,
  )

  return { files: rows.map(mapFile), total }
}

function sortClause(sort?: string, dir?: string): string {
  const direction = dir === 'asc' ? 'asc' : 'desc'
  switch (sort) {
    case 'name':
      return `order by f.name collate nocase ${direction}, f.id`
    case 'size':
      return `order by f.size_bytes ${direction}, f.id`
    case 'kind':
      return `order by f.mime_type ${direction}, f.name collate nocase`
    default:
      return `order by f.updated_at ${direction}, f.id`
  }
}

function mapFile(row: FileRow & { account_label: string; provider: string; has_share?: number }): PublicFile {
  return {
    id: row.id,
    name: row.name,
    mimeType: row.mime_type,
    kind: kindOf(row.mime_type, row.name),
    sizeBytes: Number(row.size_bytes),
    folderId: row.folder_id,
    accountId: row.account_id,
    accountLabel: row.account_label,
    provider: row.provider,
    starred: Boolean(row.starred),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    previewable: isPreviewable(row.mime_type, row.name),
    shared: Boolean(row.has_share),
  }
}

export function getFileRow(userId: string, id: string): FileRow | undefined {
  return get<FileRow>('select * from files where id = ? and user_id = ?', id, userId)
}

export function getFileWithAccount(userId: string, id: string) {
  return get<FileRow & { account_label: string; provider: string }>(
    `select f.*, a.label as account_label, a.provider from files f
     join accounts a on a.id = f.account_id
     where f.id = ? and f.user_id = ?`,
    id,
    userId,
  )
}

export function listFolders(userId: string, parentId: string | null, includeCounts = true): PublicFolder[] {
  const rows = all<FolderRow & { file_count: number }>(
    includeCounts
      ? `select d.*, (select count(*) from files f where f.folder_id = d.id and f.status = 'active') as file_count
         from folders d
         where d.user_id = ? and d.deleted_at is null and ${parentId === null ? 'd.parent_id is null' : 'd.parent_id = ?'}
         order by d.name collate nocase`
      : `select d.* from folders d
         where d.user_id = ? and d.deleted_at is null and ${parentId === null ? 'd.parent_id is null' : 'd.parent_id = ?'}
         order by d.name collate nocase`,
    ...(parentId === null ? [userId] : [userId, parentId]),
  )

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    parentId: row.parent_id,
    color: row.color,
    icon: row.icon,
    updatedAt: row.updated_at,
    fileCount: Number(row.file_count ?? 0),
  }))
}

export function folderPath(userId: string, folderId: string | null): { id: string; name: string }[] {
  const trail: { id: string; name: string }[] = []
  let current = folderId
  let guard = 0
  while (current && guard++ < 32) {
    const row = get<{ id: string; name: string; parent_id: string | null }>(
      'select id, name, parent_id from folders where id = ? and user_id = ? and deleted_at is null',
      current,
      userId,
    )
    if (!row) break
    trail.unshift({ id: row.id, name: row.name })
    current = row.parent_id
  }
  return trail
}
