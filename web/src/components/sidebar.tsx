import { useMemo, useState } from 'react'
import {
  ChevronRight,
  Clock,
  FolderPlus,
  HardDrive,
  LayoutGrid,
  Link2,
  Settings,
  Share2,
  Star,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { formatBytes } from '../lib/format'
import { Link, navigate, useLocation } from '../lib/router'
import { accountColor, FOLDER_COLORS, type FolderNode, type Stats } from '../lib/shell-data'
import { Progress } from './ui'

export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <span
      className="brand-gradient flex shrink-0 items-center justify-center rounded-[9px] text-white shadow-subtle"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinejoin="round">
        <path d="M12 3.5 19.5 8v8L12 20.5 4.5 16V8z" />
        <path d="M12 3.5v17" opacity=".55" />
      </svg>
    </span>
  )
}

const NAV = [
  { to: '/drive', label: 'All files', icon: LayoutGrid, key: 'files' },
  { to: '/recent', label: 'Recent', icon: Clock, key: 'recent' },
  { to: '/starred', label: 'Starred', icon: Star, key: 'starred' },
  { to: '/shared', label: 'Shared links', icon: Share2, key: 'shares' },
  { to: '/trash', label: 'Trash', icon: Trash2, key: 'trash' },
] as const

export function Sidebar({
  stats,
  folders,
  onNewFolder,
  onUploadClick,
  onClose,
}: {
  stats: Stats | null
  folders: FolderNode[]
  onNewFolder: () => void
  onUploadClick: () => void
  onClose?: () => void
}) {
  const { path, search } = useLocation()
  const activeFolder = search.get('folder')
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const [poolOpen, setPoolOpen] = useState(true)

  const counts: Record<string, number> = useMemo(
    () => ({
      files: stats?.counts.files ?? 0,
      shares: stats?.counts.shares ?? 0,
      trash: stats?.counts.trash ?? 0,
    }),
    [stats],
  )

  const tree = useMemo(() => {
    const children = new Map<string | null, FolderNode[]>()
    for (const folder of folders) {
      const list = children.get(folder.parentId) ?? []
      list.push(folder)
      children.set(folder.parentId, list)
    }
    return children
  }, [folders])

  const renderFolders = (parentId: string | null, depth = 0): React.ReactNode => {
    const list = tree.get(parentId) ?? []
    if (!list.length) return null

    return list.map((folder) => {
      const kids = tree.get(folder.id) ?? []
      const isOpen = expanded[folder.id] ?? true
      const isActive = activeFolder === folder.id && path === '/drive'
      return (
        <div key={folder.id}>
          <div
            className="group flex items-center gap-1 rounded-lg pr-1"
            style={{ paddingLeft: depth * 12 }}
          >
            {kids.length > 0 ? (
              <button
                onClick={() => setExpanded((prev) => ({ ...prev, [folder.id]: !isOpen }))}
                className="rounded p-1 text-faint transition hover:text-body"
                aria-label={isOpen ? 'Collapse' : 'Expand'}
              >
                <ChevronRight size={12} className={isOpen ? 'rotate-90 transition-transform' : 'transition-transform'} />
              </button>
            ) : (
              <span className="w-[22px]" />
            )}
            <Link
              to={`/drive?folder=${folder.id}`}
              onClick={onClose}
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1.5 py-1.5 text-[13px] transition ${
                isActive ? 'bg-accent-soft font-medium text-accent' : 'text-dim hover:bg-panel-2 hover:text-body'
              }`}
            >
              <span className="size-1.5 shrink-0 rounded-full" style={{ background: FOLDER_COLORS[folder.color] ?? FOLDER_COLORS.indigo }} />
              <span className="truncate">{folder.name}</span>
            </Link>
          </div>
          {kids.length > 0 && isOpen && renderFolders(folder.id, depth + 1)}
        </div>
      )
    })
  }

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <Link to="/drive" onClick={onClose} className="flex items-center gap-2.5">
          <BrandMark size={30} />
          <div className="leading-tight">
            <p className="text-[15px] font-semibold tracking-tight text-body">PSDrive</p>
            <p className="text-[10px] tracking-wide text-faint">ONE DRIVE, EVERY CLOUD</p>
          </div>
        </Link>
        {onClose && (
          <button className="btn btn-ghost btn-sm p-1.5 lg:hidden" onClick={onClose} aria-label="Close menu">
            <X size={16} />
          </button>
        )}
      </div>

      <div className="px-3">
        <button className="btn btn-primary w-full" onClick={onUploadClick}>
          <Upload size={15} />
          Upload files
        </button>
      </div>

      <nav className="mt-4 flex-1 space-y-4 overflow-y-auto px-3 pb-4">
        <div className="space-y-0.5">
          {NAV.map((item) => {
            const isActive =
              path === item.to || (item.to === '/drive' && path.startsWith('/drive') && !activeFolder)
            const count = item.key === 'files' ? counts.files : item.key === 'shares' ? counts.shares : item.key === 'trash' ? counts.trash : 0
            return (
              <Link
                key={item.to}
                to={item.to}
                onClick={onClose}
                className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition ${
                  isActive ? 'bg-accent-soft font-medium text-accent' : 'text-dim hover:bg-panel-2 hover:text-body'
                }`}
              >
                <item.icon size={16} strokeWidth={1.9} />
                <span className="flex-1">{item.label}</span>
                {count > 0 && <span className="text-[11px] tabular-nums text-faint">{count}</span>}
              </Link>
            )
          })}
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between px-2.5">
            <span className="text-[10px] font-semibold tracking-[0.09em] text-faint uppercase">Folders</span>
            <button
              onClick={onNewFolder}
              className="rounded p-1 text-faint transition hover:bg-panel-2 hover:text-body"
              aria-label="New folder"
              title="New folder"
            >
              <FolderPlus size={13} />
            </button>
          </div>
          <div className="space-y-0.5">
            {folders.length === 0 && <p className="px-2.5 py-1.5 text-[12px] text-faint">No folders yet</p>}
            {renderFolders(null)}
          </div>
        </div>

        {/* Storage pool */}
        <div className="rounded-xl border border-line bg-panel-2 p-3">
          <button
            className="flex w-full items-center justify-between text-left"
            onClick={() => setPoolOpen((v) => !v)}
          >
            <span className="flex items-center gap-1.5 text-[10px] font-semibold tracking-[0.09em] text-faint uppercase">
              <HardDrive size={12} /> Storage pool
            </span>
            <ChevronRight size={12} className={`text-faint transition-transform ${poolOpen ? 'rotate-90' : ''}`} />
          </button>

          <p className="mt-2 text-[13px] font-semibold text-body">
            {formatBytes(stats?.pool?.usedBytes ?? 0)}
            <span className="font-normal text-faint"> / {stats?.pool?.totalBytes ? formatBytes(stats.pool.totalBytes) : '∞'}</span>
          </p>

          <StackedMeter accounts={stats?.pool?.accounts ?? []} className="mt-2" />

          {poolOpen && (
            <div className="mt-2.5 space-y-1.5">
              {(stats?.pool?.accounts ?? []).map((account, index) => (
                <div key={account.id} className="flex items-center gap-2 text-[11px]">
                  <span className="size-1.5 shrink-0 rounded-full" style={{ background: accountColor(index) }} />
                  <span className="min-w-0 flex-1 truncate text-dim" title={account.label}>
                    {account.label}
                  </span>
                  <span className="tabular-nums text-faint">
                    {account.totalBytes ? formatBytes(account.availableBytes ?? 0) : '∞'}
                  </span>
                </div>
              ))}
              <Link
                to="/accounts"
                onClick={onClose}
                className="mt-1 flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
              >
                <Settings size={11} /> Manage accounts
              </Link>
            </div>
          )}
        </div>
      </nav>
    </aside>
  )
}

/** One bar showing how the pool is split across accounts. */
export function StackedMeter({
  accounts,
  className = '',
  height = 6,
}: {
  accounts: { id: string; usedBytes: number; totalBytes: number | null; sharePct: number }[]
  className?: string
  height?: number
}) {
  const total = accounts.reduce((sum, a) => sum + (a.totalBytes ?? 0), 0)
  if (total === 0) {
    return <div className={`w-full rounded-full bg-panel-3 ${className}`} style={{ height }} />
  }

  return (
    <div className={`flex w-full overflow-hidden rounded-full bg-panel-3 ${className}`} style={{ height }}>
      {accounts.map((account, index) => {
        const width = ((account.totalBytes ?? 0) / total) * 100
        const fill = Math.max(0, Math.min(100, account.sharePct))
        return (
          <div key={account.id} className="relative h-full" style={{ width: `${width}%` }} title={`${account.sharePct.toFixed(0)}% used`}>
            <div className="absolute inset-y-0 right-0 w-px bg-panel" />
            <div
              className="h-full transition-[width] duration-500"
              style={{ width: `${fill}%`, background: accountColor(index) }}
            />
          </div>
        )
      })}
    </div>
  )
}

export function PoolCard({ stats }: { stats: Stats | null }) {
  const pool = stats?.pool
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.08em] text-faint uppercase">Pooled storage</p>
          <p className="mt-1 text-2xl font-semibold tracking-tight text-body">
            {formatBytes(pool?.usedBytes ?? 0)}
            <span className="text-base font-normal text-faint"> / {pool?.totalBytes ? formatBytes(pool.totalBytes) : '∞'}</span>
          </p>
        </div>
        <Link to="/accounts" className="btn btn-outline btn-sm">
          Manage
        </Link>
      </div>
      <StackedMeter accounts={pool?.accounts ?? []} className="mt-3" height={8} />
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-panel-2 px-2 py-2">
          <p className="text-[10px] tracking-wide text-faint uppercase">Free</p>
          <p className="mt-0.5 text-[13px] font-semibold text-body">{pool?.availableBytes != null ? formatBytes(pool.availableBytes) : '∞'}</p>
        </div>
        <div className="rounded-lg bg-panel-2 px-2 py-2">
          <p className="text-[10px] tracking-wide text-faint uppercase">Accounts</p>
          <p className="mt-0.5 text-[13px] font-semibold text-body">{pool?.accountCount ?? 0}</p>
        </div>
        <div className="rounded-lg bg-panel-2 px-2 py-2">
          <p className="text-[10px] tracking-wide text-faint uppercase">Used</p>
          <p className="mt-0.5 text-[13px] font-semibold text-body">{(pool?.usedPct ?? 0).toFixed(1)}%</p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {(pool?.accounts ?? []).map((account, index) => (
          <div key={account.id}>
            <div className="flex items-center justify-between text-[11px]">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: accountColor(index) }} />
                <span className="truncate text-dim">{account.label}</span>
              </span>
              <span className="ml-2 shrink-0 tabular-nums text-faint">
                {formatBytes(account.usedBytes)} / {account.totalBytes ? formatBytes(account.totalBytes) : '∞'}
              </span>
            </div>
            <Progress value={account.sharePct} height={3} className="mt-1" tone={account.sharePct > 92 ? 'danger' : 'accent'} />
          </div>
        ))}
      </div>
    </div>
  )
}

export { navigate, Link2 }
