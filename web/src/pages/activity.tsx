import { useEffect, useState } from 'react'
import {
  Activity as ActivityIcon,
  Cloud,
  FilePlus2,
  FolderPlus,
  KeyRound,
  Link2,
  Pencil,
  Share2,
  Trash2,
  UserPlus,
} from 'lucide-react'
import { api, type ActivityItem } from '../lib/api'
import { formatDateTime, timeAgo } from '../lib/format'
import { EmptyState } from '../components/ui'

const VISUALS: Record<string, { icon: typeof FilePlus2; color: string; label: string }> = {
  'file.uploaded': { icon: FilePlus2, color: '#34d399', label: 'Uploaded' },
  'file.trashed': { icon: Trash2, color: '#f87171', label: 'Moved to trash' },
  'file.restored': { icon: FilePlus2, color: '#60a5fa', label: 'Restored' },
  'file.purged': { icon: Trash2, color: '#f87171', label: 'Deleted permanently' },
  'file.renamed': { icon: Pencil, color: '#a78bfa', label: 'Renamed' },
  'file.moved': { icon: Pencil, color: '#a78bfa', label: 'Moved' },
  'file.starred': { icon: ActivityIcon, color: '#fbbf24', label: 'Starred' },
  'file.deleted': { icon: Trash2, color: '#f87171', label: 'Deleted' },
  'folder.created': { icon: FolderPlus, color: '#818cf8', label: 'Folder created' },
  'folder.updated': { icon: Pencil, color: '#818cf8', label: 'Folder updated' },
  'folder.deleted': { icon: Trash2, color: '#f87171', label: 'Folder deleted' },
  'share.created': { icon: Share2, color: '#22d3ee', label: 'Share link created' },
  'share.revoked': { icon: Link2, color: '#94a3b8', label: 'Share link revoked' },
  'account.connected': { icon: Cloud, color: '#34d399', label: 'Account connected' },
  'account.reconnected': { icon: Cloud, color: '#34d399', label: 'Account reconnected' },
  'account.disconnected': { icon: Cloud, color: '#f87171', label: 'Account disconnected' },
  'api_key.created': { icon: KeyRound, color: '#fbbf24', label: 'API key created' },
  'api_key.revoked': { icon: KeyRound, color: '#94a3b8', label: 'API key revoked' },
  'account.created': { icon: UserPlus, color: '#818cf8', label: 'Account created' },
  'trash.emptied': { icon: Trash2, color: '#f87171', label: 'Trash emptied' },
}

export function ActivityPage() {
  const [items, setItems] = useState<ActivityItem[] | null>(null)
  const [before, setBefore] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  const load = (cursor?: number) => {
    setLoading(true)
    api
      .get<{ activity: ActivityItem[]; nextBefore: number | null }>(`/api/activity?limit=50${cursor ? `&before=${cursor}` : ''}`)
      .then((data) => {
        setItems((previous) => (cursor && previous ? [...previous, ...data.activity] : data.activity))
        setBefore(data.nextBefore)
      })
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <div className="mx-auto w-full max-w-[860px] px-4 pb-24 pt-5 sm:px-6">
      <div className="mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-body">Activity</h1>
        <p className="mt-0.5 text-[12.5px] text-dim">Everything that happened in this drive.</p>
      </div>

      {!items ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="skeleton h-14 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={<ActivityIcon size={20} />} title="Nothing here yet" description="Actions you take will show up in this timeline." />
      ) : (
        <div className="relative pl-6">
          <span className="absolute top-2 bottom-2 left-[9px] w-px bg-[var(--border)]" />
          {items.map((item) => {
            const visual = VISUALS[item.action] ?? { icon: ActivityIcon, color: '#94a3b8', label: item.action }
            const Icon = visual.icon
            return (
              <div key={item.id} className="relative mb-3 last:mb-0">
                <span
                  className="absolute top-3 -left-6 flex size-[18px] items-center justify-center rounded-full border-2 border-[var(--panel)]"
                  style={{ background: `${visual.color}22`, color: visual.color }}
                >
                  <Icon size={9} />
                </span>
                <div className="card flex flex-wrap items-center gap-2 px-3.5 py-2.5">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[12.5px] text-body">
                      <span className="font-medium">{visual.label}</span>
                      {item.entityName && <span className="text-dim"> · {item.entityName}</span>}
                    </p>
                    <p className="text-[10.5px] text-faint" title={formatDateTime(item.createdAt)}>
                      {timeAgo(item.createdAt)}
                      {typeof item.meta?.size === 'number' ? ` · ${(item.meta.size / 1024).toFixed(0)} KB` : ''}
                      {typeof item.meta?.account === 'string' ? ` · ${item.meta.account}` : ''}
                      {typeof item.meta?.count === 'number' ? ` · ${item.meta.count} file(s)` : ''}
                    </p>
                  </div>
                </div>
              </div>
            )
          })}

          {before && (
            <div className="flex justify-center pt-2">
              <button className="btn btn-outline btn-sm" onClick={() => load(before)} disabled={loading}>
                {loading ? 'Loading…' : 'Load older activity'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
