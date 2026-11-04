import { DatabaseSync } from 'node:sqlite'
import { config } from '../config.ts'

/**
 * A very small, very fast data layer over node:sqlite.
 *
 * Why this instead of an ORM:
 *  - zero native dependencies (node:sqlite ships with Node 22)
 *  - no codegen, no migration engine, no connection pool, no TCP hop
 *  - prepared statements are cached, so hot queries cost ~1µs to bind
 *
 * WAL mode lets reads run concurrently with writes, which is exactly the
 * access pattern of a file manager (heavy listing, occasional writes).
 */

export type Param = string | number | bigint | null | Uint8Array | boolean | undefined
type Row = Record<string, unknown>

const db = new DatabaseSync(config.dbPath)

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA cache_size = -32000;
  PRAGMA temp_store = MEMORY;
  PRAGMA mmap_size = 268435456;
`)

/** node:sqlite refuses booleans/undefined — normalise them once, here. */
function normalise(params: Param[]): (string | number | bigint | null | Uint8Array)[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null
    if (typeof p === 'boolean') return p ? 1 : 0
    return p as string | number | bigint | Uint8Array
  })
}

type Cached = { statement: ReturnType<typeof db.prepare>; params: number }
const cache = new Map<string, Cached>()

/**
 * Cached prepare + a bind-count assertion.
 *
 * The assertion is what you get from a typed ORM for free: if a query declares
 * three placeholders and the call site passes two, SQLite silently binds NULL
 * and the query "just" returns no rows. That is a brutal bug to chase, so we
 * fail loudly on the first request instead.
 */
function stmt(sql: string, count: number): ReturnType<typeof db.prepare> {
  let entry = cache.get(sql)
  if (!entry) {
    entry = { statement: db.prepare(sql), params: (sql.match(/\?/g) ?? []).length }
    if (cache.size > 500) cache.clear()
    cache.set(sql, entry)
  }
  if (entry.params !== count) {
    throw new Error(
      `SQL bind mismatch: query expects ${entry.params} parameters but ${count} were provided.\n${sql.slice(0, 200)}`,
    )
  }
  return entry.statement
}

export function all<T = Row>(sql: string, ...params: Param[]): T[] {
  return stmt(sql, params.length).all(...normalise(params)) as T[]
}

export function get<T = Row>(sql: string, ...params: Param[]): T | undefined {
  return stmt(sql, params.length).get(...normalise(params)) as T | undefined
}

export function run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
  const r = stmt(sql, params.length).run(...normalise(params))
  return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) }
}

export function pluck<T = unknown>(sql: string, ...params: Param[]): T | undefined {
  const row = get<Row>(sql, ...params)
  return row ? (Object.values(row)[0] as T) : undefined
}

let depth = 0
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn()
  depth++
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  } finally {
    depth--
  }
}

export function exec(sql: string): void {
  db.exec(sql)
}

export function closeDb(): void {
  try {
    db.close()
  } catch {
    /* already closed */
  }
}

export { db }
