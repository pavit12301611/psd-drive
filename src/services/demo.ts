import { existsSync, readFileSync } from 'node:fs'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { config } from '../config.ts'
import { get, run } from '../db/index.ts'
import { hashPassword, newId } from '../lib/crypto.ts'
import { log } from '../lib/logger.ts'

const DEMO_EMAIL = 'demo@psdrive.local'
const DEMO_PASSWORD = 'demo1234'
const GB = 1024 ** 3

export type DemoUser = { id: string; email: string; name: string }

/**
 * Seeds a complete, explorable workspace on first boot.
 *
 * Everything is stored through the real local provider, so uploads, previews,
 * downloads, sharing and routing all exercise production code paths. No
 * external service and no fake in-memory fixtures.
 */
export async function ensureDemoUser(): Promise<DemoUser> {
  const existing = get<{ id: string; email: string; name: string }>(
    'select id, email, name from users where email = ?',
    DEMO_EMAIL,
  )

  if (existing) {
    const accountCount = get<{ c: number }>('select count(*) as c from accounts where user_id = ?', existing.id)?.c ?? 0
    if (Number(accountCount) === 0) await seedWorkspace(existing.id)
    return existing
  }

  const id = newId()
  const now = Date.now()
  run(
    `insert into users (id, name, email, password_hash, role, status, created_at, updated_at)
     values (?, ?, ?, ?, 'owner', 'active', ?, ?)`,
    id,
    'Demo User',
    DEMO_EMAIL,
    hashPassword(DEMO_PASSWORD),
    now,
    now,
  )

  await seedWorkspace(id)
  log.info('demo workspace created', { email: DEMO_EMAIL, password: DEMO_PASSWORD })
  return { id, email: DEMO_EMAIL, name: 'Demo User' }
}

type SeedAccount = { id: string; label: string; quota: number | null }

function createAccount(userId: string, label: string, quota: number | null, priority: number): SeedAccount {
  const id = newId()
  const now = Date.now()
  run(
    `insert into accounts (id, user_id, provider, label, provider_account_id, config, total_bytes, used_bytes,
       available_bytes, quota_synced_at, priority, enabled, is_demo, status, created_at, updated_at)
     values (?, ?, 'local', ?, ?, '{}', ?, 0, ?, ?, ?, 1, 1, 'connected', ?, ?)`,
    id,
    userId,
    label,
    newId(),
    quota,
    quota,
    now,
    priority,
    now,
    now,
  )
  return { id, label, quota }
}

function createFolder(userId: string, name: string, icon: string, color: string, parentId: string | null = null): string {
  const id = newId()
  const now = Date.now()
  run(
    'insert into folders (id, user_id, parent_id, name, color, icon, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    userId,
    parentId,
    name,
    color,
    icon,
    now,
    now,
  )
  return id
}

async function writeBlob(accountId: string, id: string, chunks: Iterable<Uint8Array>): Promise<number> {
  const dir = path.join(config.blobDir, accountId)
  await mkdir(dir, { recursive: true })
  const filePath = path.join(dir, id)
  const stream = createWriteStream(filePath)
  let size = 0
  for (const chunk of chunks) {
    size += chunk.byteLength
    if (!stream.write(chunk)) {
      await new Promise<void>((resolve) => stream.once('drain', () => resolve()))
    }
  }
  await new Promise<void>((resolve, reject) => {
    stream.end(() => resolve())
    stream.on('error', reject)
  })
  return size
}

function* randomChunks(totalBytes: number, chunkSize = 512 * 1024): Generator<Uint8Array> {
  let written = 0
  while (written < totalBytes) {
    const size = Math.min(chunkSize, totalBytes - written)
    yield randomBytes(size)
    written += size
  }
}

type SeedFile = {
  accountId: string
  folderId: string | null
  name: string
  mime: string
  chunks: Iterable<Uint8Array>
  /** Backdate so "Recent" and "Last modified" look plausible. */
  ageDays: number
}

async function addFile(userId: string, file: SeedFile): Promise<void> {
  const id = newId()
  const providerFileId = newId()
  const size = await writeBlob(file.accountId, providerFileId, file.chunks)
  const at = Date.now() - file.ageDays * 86_400_000

  run(
    `insert into files (id, user_id, account_id, folder_id, provider_file_id, name, mime_type, size_bytes,
       status, starred, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    id,
    userId,
    file.accountId,
    file.folderId,
    providerFileId,
    file.name,
    file.mime,
    size,
    Math.random() < 0.15 ? 1 : 0,
    at,
    at,
  )
}

/** Minimal but valid single-page PDF (correct xref offsets, Helvetica). */
export function buildPdf(title: string, lines: string[]): Uint8Array {
  const escape = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)
  const body = [
    'BT /F1 22 Tf 64 770 Td (' + escape(title) + ') Tj ET',
    ...lines.map((line, i) => `BT /F1 11 Tf 64 ${740 - i * 18} Td (${escape(line)}) Tj ET`),
  ].join('\n')

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
  ]

  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })

  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`

  return new TextEncoder().encode(pdf)
}

function asset(name: string): Uint8Array | null {
  const file = path.join(config.root, 'demo-assets', name)
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : null
}

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

/** Builds the sample library. Safe to run more than once per account set. */
async function seedWorkspace(userId: string): Promise<void> {
  const personal = createAccount(userId, 'Personal Drive', 15 * GB, 0)
  const work = createAccount(userId, 'Work Drive', 15 * GB, 1)
  // A nearly-full account on purpose: uploads visibly route around it.
  const archive = createAccount(userId, 'Archive (nearly full)', 32 * 1024 * 1024, 2)

  const photos = createFolder(userId, 'Photos', 'image', 'violet')
  const documents = createFolder(userId, 'Documents', 'file-text', 'blue')
  const projects = createFolder(userId, 'Projects', 'code', 'emerald')
  const design = createFolder(userId, 'Design', 'palette', 'amber')
  const backups = createFolder(userId, 'Backups', 'archive', 'rose')
  const trips = createFolder(userId, 'Trips 2026', 'plane', 'cyan', photos)

  const photoAssets: { file: string; name: string; mime: string; days: number }[] = [
    { file: 'mountains.jpg', name: 'Himalayan ridge at sunrise.jpg', mime: 'image/jpeg', days: 3 },
    { file: 'desk.jpg', name: 'Workspace setup.jpg', mime: 'image/jpeg', days: 9 },
    { file: 'coast.jpg', name: 'Coastline from the trail.jpg', mime: 'image/jpeg', days: 17 },
    { file: 'abstract.jpg', name: 'Brand gradient study.jpg', mime: 'image/jpeg', days: 27 },
  ]

  const seededPhotos: SeedFile[] = []
  for (const [index, item] of photoAssets.entries()) {
    const data = asset(item.file)
    if (!data) continue
    seededPhotos.push({
      accountId: personal.id,
      folderId: index === 1 ? trips : photos,
      name: item.name,
      mime: item.mime,
      chunks: [data],
      ageDays: item.days,
    })
  }

  if (seededPhotos.length === 0) {
    // Fallback so a fresh clone without demo assets still shows an image.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="900" cy="220" r="140" fill="#ffffff" fill-opacity="0.18"/><text x="70" y="430" font-family="system-ui,sans-serif" font-size="76" fill="#fff" font-weight="600">PSDrive</text><text x="72" y="490" font-family="system-ui,sans-serif" font-size="30" fill="#ffffffcc">One drive for every cloud</text></svg>`
    seededPhotos.push({
      accountId: personal.id,
      folderId: photos,
      name: 'PSDrive cover.svg',
      mime: 'image/svg+xml',
      chunks: [bytes(svg)],
      ageDays: 2,
    })
  }

  const files: SeedFile[] = [
    ...seededPhotos,

    {
      accountId: personal.id,
      folderId: documents,
      name: 'Q3 summary.pdf',
      mime: 'application/pdf',
      chunks: [
        buildPdf('Q3 storage summary', [
          'All figures are aggregates across connected storage accounts.',
          '',
          'Total capacity          45.0 GB',
          'Used                    0.14 GB',
          'Largest account         Personal Drive',
          '',
          'Uploads route automatically to the account with the most free space,',
          'so no single provider fills up first.',
        ]),
      ],
      ageDays: 1,
    },
    {
      accountId: work.id,
      folderId: documents,
      name: 'Invoice 2026-014.pdf',
      mime: 'application/pdf',
      chunks: [
        buildPdf('Invoice 2026-014', [
          'Billed to      Studio North',
          'Issued         12 October 2026',
          'Due            12 November 2026',
          '',
          'Design retainer            2,400.00',
          'Storage migration            650.00',
          'Total                      3,050.00',
        ]),
      ],
      ageDays: 6,
    },
    {
      accountId: work.id,
      folderId: documents,
      name: 'notes.md',
      mime: 'text/markdown',
      chunks: [
        bytes(
          `# Storage migration notes\n\n- [x] Connect the new bucket\n- [x] Verify quota reporting\n- [ ] Move the 2024 archive\n- [ ] Rotate API keys\n\nUploads stream straight through the server, so a 4 GB file costs\nabout the same memory as a 4 KB one.\n`,
        ),
      ],
      ageDays: 2,
    },
    {
      accountId: work.id,
      folderId: documents,
      name: 'expenses.csv',
      mime: 'text/csv',
      chunks: [
        bytes(
          'date,category,description,amount\n2026-09-02,travel,Train to Delhi,1240.00\n2026-09-14,software,Design suite,4999.00\n2026-09-21,hardware,2TB SSD,8900.00\n2026-10-01,meals,Team lunch,2150.00\n',
        ),
      ],
      ageDays: 4,
    },
    {
      accountId: work.id,
      folderId: projects,
      name: 'index.html',
      mime: 'text/html',
      chunks: [
        bytes(
          `<!doctype html>\n<html>\n  <head><title>Landing</title></head>\n  <body>\n    <h1>Ship faster</h1>\n    <p>Static prototype.</p>\n  </body>\n</html>\n`,
        ),
      ],
      ageDays: 11,
    },
    {
      accountId: work.id,
      folderId: projects,
      name: 'schema.sql',
      mime: 'text/plain',
      chunks: [
        bytes(
          'create table files (\n  id text primary key,\n  name text not null,\n  size_bytes integer not null default 0\n);\n',
        ),
      ],
      ageDays: 12,
    },
    {
      accountId: personal.id,
      folderId: design,
      name: 'psdrive-mark.svg',
      mime: 'image/svg+xml',
      chunks: [
        bytes(
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#a)"/><path d="M32 16l14 9v16l-14 9-14-9V25z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/></svg>`,
        ),
      ],
      ageDays: 8,
    },
  ]

  for (const file of files) {
    await addFile(userId, file)
  }

  // Two incompressible archives that bring the Archive account to ~92% full.
  if (archive.quota) {
    const target = Math.floor(archive.quota * 0.92)
    const chunkSize = Math.floor(target / 2)
    await addFile(userId, {
      accountId: archive.id,
      folderId: backups,
      name: 'photos-2024.zip',
      mime: 'application/zip',
      chunks: randomChunks(chunkSize),
      ageDays: 45,
    })
    await addFile(userId, {
      accountId: archive.id,
      folderId: backups,
      name: 'laptop-backup.tar.gz',
      mime: 'application/gzip',
      chunks: randomChunks(target - chunkSize),
      ageDays: 60,
    })
  }
  // One example share so the Shared page is not empty.
  const sharedFile = get<{ id: string; name: string }>(
    "select id, name from files where user_id = ? and name = 'Q3 summary.pdf' limit 1",
    userId,
  )
  if (sharedFile) {
    const token = randomBytes(16).toString('base64url')
    run(
      'insert into shares (id, user_id, file_id, token, expires_at, download_count, view_count, enabled, created_at) values (?, ?, ?, ?, NULL, 3, 11, 1, ?)',
      newId(),
      userId,
      sharedFile.id,
      token,
      Date.now() - 2 * 86_400_000,
    )
  }

  for (const [action, entity, name, days] of [
    ['file.uploaded', 'file', 'Himalayan ridge at sunrise.jpg', 3],
    ['account.connected', 'account', 'Personal Drive', 30],
    ['share.created', 'share', 'Q3 summary.pdf', 2],
    ['folder.created', 'folder', 'Projects', 14],
    ['file.uploaded', 'file', 'Invoice 2026-014.pdf', 6],
    ['account.connected', 'account', 'Archive (nearly full)', 30],
  ] as const) {
    run(
      'insert into activity (id, user_id, action, entity_type, entity_id, entity_name, meta, created_at) values (?, ?, ?, ?, ?, ?, NULL, ?)',
      newId(),
      userId,
      action,
      entity,
      newId(),
      name,
      Date.now() - days * 86_400_000,
    )
  }

  log.info('demo workspace seeded', { files: files.length + 2 })
}

