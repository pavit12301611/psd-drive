import { all, run } from '../db/index.ts'
import { newId } from '../lib/crypto.ts'

export type ActivityInput = {
  userId: string
  action: string
  entityType: 'file' | 'folder' | 'account' | 'share' | 'api_key' | 'user'
  entityId?: string | null
  entityName?: string | null
  meta?: Record<string, unknown>
}

/** Fire-and-forget audit trail. Never throws into the request path. */
export function logActivity(input: ActivityInput): void {
  try {
    run(
      `insert into activity (id, user_id, action, entity_type, entity_id, entity_name, meta, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?)`,
      newId(),
      input.userId,
      input.action,
      input.entityType,
      input.entityId ?? null,
      input.entityName ?? null,
      input.meta ? JSON.stringify(input.meta) : null,
      Date.now(),
    )
  } catch {
    /* logging must never break a request */
  }
}

export type ActivityItem = {
  id: string
  action: string
  entityType: string
  entityId: string | null
  entityName: string | null
  meta: Record<string, unknown> | null
  createdAt: number
}

export function listActivity(userId: string, limit = 50, before?: number): ActivityItem[] {
  const rows = before
    ? all<Record<string, unknown>>(
        'select * from activity where user_id = ? and created_at < ? order by created_at desc limit ?',
        userId,
        before,
        limit,
      )
    : all<Record<string, unknown>>(
        'select * from activity where user_id = ? order by created_at desc limit ?',
        userId,
        limit,
      )

  return rows.map((row) => ({
    id: String(row.id),
    action: String(row.action),
    entityType: String(row.entity_type),
    entityId: row.entity_id ? String(row.entity_id) : null,
    entityName: row.entity_name ? String(row.entity_name) : null,
    meta: row.meta ? (JSON.parse(String(row.meta)) as Record<string, unknown>) : null,
    createdAt: Number(row.created_at),
  }))
}
