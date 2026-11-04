import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownWideNarrow,
  ArrowUpWideNarrow,
  Download,
  FolderInput,
  FolderPlus,
  Grid2x2,
  Link2,
  List,
  MoreVertical,
  Pencil,
  Share2,
  Star,
  Trash2,
  Undo2,
  Upload,
} from 'lucide-react'
import {
  api,
  type FileItem,
  type FolderItem,
  contentUrl,
  downloadUrl,
} from '../lib/api'
import { useToast, useUploads } from '../lib/app-context'
import { emit } from '../lib/bus'
import { formatBytes, timeAgo } from '../lib/format'
import { navigate, useLocation } from '../lib/router'
import { FOLDER_COLORS, type FolderNode, type Stats } from '../lib/shell-data'
import { ContextMenu, type MenuItem } from '../components/context-menu'
import { FileIcon, FileTile, extLabel, fileVisual } from '../components/file-icon'
import { PreviewModal } from '../components/preview'
import { Chip, EmptyState, Modal, Spinner } from '../components/ui'

type FilesResponse = {
  files: FileItem[]
  folders: FolderItem[]
  total: number
  breadcrumb: { id: string; name: string }[]
}

const VIEW_TITLES: Record<string, { title: string; subtitle: string }> = {
  all: { title: 'All files', subtitle: 'Everything across your connected accounts' },
  recent: { title: 'Recent', subtitle: 'Files you touched most recently' },
  starred: { title: 'Starred', subtitle: 'Your hand-picked favourites' },
  trash: { title: 'Trash', subtitle: 'Deleted files are kept until you empty the trash' },
}

const PAGE_SIZE = 60

export function DrivePage({
  view,
  query,
  stats,
  onUploadClick,
  onNewFolder,
  folders,
}: {
  view: 'all' | 'recent' | 'starred' | 'trash'
  query: string
  stats: Stats | null
  onUploadClick: () => void
  onNewFolder: () => void
  folders: FolderNode[]
}) {
  const { search } = useLocation()
  const folderId = search.get('folder')
  const { toast } = useToast()
  const { revision } = useUploads()

  const [data, setData] = useState<FilesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [debounced, setDebounced] = useState(query)
  const [sort, setSort] = useState<'updated' | 'name' | 'size'>('updated')
  const [dir, setDir] = useState<'asc' | 'desc'>('desc')
  const [layout, setLayout] = useState<'list' | 'grid'>(() => (localStorage.getItem('psdrive.layout') as 'list' | 'grid') ?? 'list')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [menu, setMenu] = useState<{ x: number; y: number; file: FileItem } | null>(null)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [renaming, setRenaming] = useState<FileItem | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [moving, setMoving] = useState<FileItem[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [offset, setOffset] = useState(0)
  const lastClicked = useRef<number | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query), 180)
    return () => clearTimeout(timer)
  }, [query])

  useEffect(() => {
    localStorage.setItem('psdrive.layout', layout)
  }, [layout])

  useEffect(() => {
    setOffset(0)
    setSelected(new Set())
  }, [view, folderId, debounced, sort, dir])

  const load = useCallback(async () => {
    setLoading(true)
    const params = new URLSearchParams({
      view,
      sort,
      dir,
      limit: String(PAGE_SIZE),
      offset: String(offset),
    })
    if (folderId) params.set('folderId', folderId)
    if (debounced.trim()) params.set('q', debounced.trim())

    try {
      const result = await api.get<FilesResponse>(`/api/files?${params.toString()}`)
      setData((previous) => (offset > 0 && previous ? { ...result, files: [...previous.files, ...result.files] } : result))
      setError(null)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [view, folderId, debounced, sort, dir, offset])

  useEffect(() => {
    void load()
  }, [load, revision])

  const files = data?.files ?? []
  const currentFolder = folderId ? folders.find((f) => f.id === folderId) : null
  const heading = folderId && currentFolder ? currentFolder.name : (VIEW_TITLES[view]?.title ?? 'Files')

  /* ------------------------------- selection ------------------------------ */

  const toggleSelect = (file: FileItem, index: number, event: React.MouseEvent) => {
    setSelected((previous) => {
      const next = new Set(previous)
      if (event.shiftKey && lastClicked.current !== null) {
        const [start, end] = [lastClicked.current, index].sort((a, b) => a - b)
        for (let i = start; i <= end; i++) next.add(files[i].id)
        return next
      }
      if (next.has(file.id)) next.delete(file.id)
      else next.add(file.id)
      return next
    })
    lastClicked.current = index
  }

  const selectAll = () => {
    setSelected((previous) => (previous.size === files.length ? new Set() : new Set(files.map((f) => f.id))))
  }

  /* --------------------------------- actions ------------------------------- */

  const openFile = (file: FileItem) => {
    if (!file.previewable) {
      window.location.href = downloadUrl(file.id)
      return
    }
    setPreviewIndex(files.findIndex((f) => f.id === file.id))
  }

  const patchFile = async (file: FileItem, body: Record<string, unknown>, successMessage?: string) => {
    try {
      await api.patch(`/api/files/${file.id}`, body)
      if (successMessage) toast({ title: successMessage, tone: 'success' })
      await load()
      emit('refresh')
    } catch (err) {
      toast({ title: 'Action failed', description: (err as Error).message, tone: 'error' })
    }
  }

  const bulk = async (action: string, extra: Record<string, unknown> = {}, message?: string) => {
    if (!selected.size) return
    setBusy(true)
    try {
      await api.post('/api/files/bulk', { ids: [...selected], action, ...extra })
      setSelected(new Set())
      setMoving(null)
      await load()
      emit('refresh')
      if (message) toast({ title: message, tone: 'success' })
    } catch (err) {
      toast({ title: 'Action failed', description: (err as Error).message, tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const shareFile = async (file: FileItem) => {
    try {
      const result = await api.post<{ share: { url: string } }>('/api/shares', { fileId: file.id })
      const url = result.share.url
      await navigator.clipboard?.writeText(url).catch(() => {})
      toast({ title: 'Share link copied', description: url, tone: 'success' })
      await load()
      emit('refresh')
    } catch (err) {
      toast({ title: 'Could not create link', description: (err as Error).message, tone: 'error' })
    }
  }

  const menuItems = (file: FileItem): MenuItem[] => [
    { label: 'Preview', icon: <FileIcon kind={file.kind} size={14} />, onClick: () => openFile(file) },
    { label: 'Download', icon: <Download size={14} />, onClick: () => window.location.assign(downloadUrl(file.id)) },
    {
      label: 'Share link',
      icon: <Share2 size={14} />,
      onClick: () => void shareFile(file),
    },
    { separator: true },
    {
      label: 'Rename',
      icon: <Pencil size={14} />,
      onClick: () => {
        setRenaming(file)
        setRenameValue(file.name)
      },
    },
    { label: 'Move to…', icon: <FolderInput size={14} />, onClick: () => setMoving([file]) },
    {
      label: file.starred ? 'Remove star' : 'Add star',
      icon: <Star size={14} />,
      onClick: () => void patchFile(file, { starred: !file.starred }),
    },
    { separator: true },
    view === 'trash'
      ? {
          label: 'Restore',
          icon: <Undo2 size={14} />,
          onClick: async () => {
            await api.post('/api/files/bulk', { ids: [file.id], action: 'restore' })
            await load()
            emit('refresh')
            toast({ title: 'Restored', tone: 'success' })
          },
        }
      : {
          label: 'Move to trash',
          icon: <Trash2 size={14} />,
          danger: true,
          shortcut: 'Del',
          onClick: async () => {
            await api.post('/api/files/bulk', { ids: [file.id], action: 'trash' })
            await load()
            emit('refresh')
            toast({ title: 'Moved to trash', tone: 'success' })
          },
        },
    {
      label: 'Delete forever',
      icon: <Trash2 size={14} />,
      danger: true,
      onClick: async () => {
        setBusy(true)
        try {
          await api.post('/api/files/bulk', { ids: [file.id], action: 'purge' })
          await load()
          emit('refresh')
          toast({ title: 'Deleted permanently', tone: 'success' })
        } finally {
          setBusy(false)
        }
      },
    },
  ]

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return
      if (event.key === 'Escape') {
        setSelected(new Set())
        setPreviewIndex(null)
      }
      if (event.key === 'Delete' && selected.size && view !== 'trash') void bulk('trash', {}, 'Moved to trash')
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && files.length) {
        event.preventDefault()
        setSelected(new Set(files.map((f) => f.id)))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, files, view])

  const sortButton = (key: 'name' | 'size' | 'updated', label: string) => (
    <button
      onClick={() => {
        if (sort === key) setDir(dir === 'asc' ? 'desc' : 'asc')
        else {
          setSort(key)
          setDir(key === 'name' ? 'asc' : 'desc')
        }
      }}
      className={`flex items-center gap-1 transition hover:text-body ${sort === key ? 'text-body' : ''}`}
    >
      {label}
      {sort === key && (dir === 'asc' ? <ArrowUpWideNarrow size={12} /> : <ArrowDownWideNarrow size={12} />)}
    </button>
  )

  const emptyState = useMemo(() => {
    if (view === 'trash') {
      return (
        <EmptyState
          icon={<Trash2 size={20} />}
          title="Trash is empty"
          description="Deleted files land here first, so you can always undo a mistake."
        />
      )
    }
    if (debounced) {
      return <EmptyState icon={<List size={20} />} title="No matches" description={`Nothing here matches “${debounced}”.`} />
    }
    if (view === 'starred') {
      return <EmptyState icon={<Star size={20} />} title="No starred files" description="Star files you want to find again quickly." />
    }
    return (
      <EmptyState
        icon={<Upload size={20} />}
        title="This folder is empty"
        description="Drop files anywhere on this page, or use the Upload button."
        action={
          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={onUploadClick}>
              <Upload size={15} /> Upload files
            </button>
            <button className="btn btn-outline" onClick={onNewFolder}>
              <FolderPlus size={15} /> New folder
            </button>
          </div>
        }
      />
    )
  }, [view, debounced, onUploadClick, onNewFolder])

  return (
    <div className="mx-auto w-full max-w-[1400px] px-4 pb-24 pt-5 sm:px-6">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {folderId && currentFolder && data?.breadcrumb?.length ? (
            <nav className="mb-1 flex flex-wrap items-center gap-1 text-[12px] text-faint">
              <button className="hover:text-body" onClick={() => navigate('/drive')}>
                All files
              </button>
              {data.breadcrumb.map((crumb) => (
                <span key={crumb.id} className="flex items-center gap-1">
                  <span>/</span>
                  <button className="hover:text-body" onClick={() => navigate(`/drive?folder=${crumb.id}`)}>
                    {crumb.name}
                  </button>
                </span>
              ))}
            </nav>
          ) : null}
          <h1 className="truncate text-xl font-semibold tracking-tight text-body">{heading}</h1>
          <p className="mt-0.5 text-[12.5px] text-dim">
            {loading && !data ? 'Loading…' : `${data?.total ?? 0} ${data?.total === 1 ? 'item' : 'items'}`}
            {debounced ? ` matching “${debounced}”` : ''}
            {view === 'all' && !folderId && stats?.pool?.totalBytes
              ? ` · ${formatBytes(stats.pool.availableBytes ?? 0)} free`
              : ''}
          </p>
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex items-center gap-1 rounded-lg border border-line bg-panel p-0.5">
            <button
              onClick={() => setLayout('list')}
              className={`rounded-md p-1.5 transition ${layout === 'list' ? 'bg-panel-3 text-body' : 'text-faint hover:text-body'}`}
              aria-label="List view"
            >
              <List size={15} />
            </button>
            <button
              onClick={() => setLayout('grid')}
              className={`rounded-md p-1.5 transition ${layout === 'grid' ? 'bg-panel-3 text-body' : 'text-faint hover:text-body'}`}
              aria-label="Grid view"
            >
              <Grid2x2 size={15} />
            </button>
          </div>
          <button className="btn btn-outline btn-sm" onClick={onNewFolder}>
            <FolderPlus size={14} />
            <span className="hidden sm:inline">New folder</span>
          </button>
        </div>
      </div>

      {/* Selection toolbar */}
      {selected.size > 0 && (
        <div className="animate-pop-in mb-3 flex flex-wrap items-center gap-2 rounded-xl border border-line bg-panel px-3 py-2">
          <span className="text-[12.5px] font-medium text-body">{selected.size} selected</span>
          <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Set())}>
            Clear
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-1.5">
            <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => void bulk('star', {}, 'Starred')}>
              <Star size={13} /> Star
            </button>
            <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => setMoving(files.filter((f) => selected.has(f.id)))}>
              <FolderInput size={13} /> Move
            </button>
            {selected.size === 1 && (
              <button
                className="btn btn-outline btn-sm"
                onClick={() => void shareFile(files.find((f) => selected.has(f.id))!)}
              >
                <Link2 size={13} /> Share
              </button>
            )}
            {view === 'trash' ? (
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void bulk('purge', {}, 'Deleted permanently')}>
                <Trash2 size={13} /> Delete forever
              </button>
            ) : (
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => void bulk('trash', {}, 'Moved to trash')}>
                <Trash2 size={13} /> Trash
              </button>
            )}
          </div>
        </div>
      )}

      {error && (
        <div className="mb-3 rounded-xl border border-line bg-panel px-3 py-2 text-[12.5px] text-danger">{error}</div>
      )}

      {/* Folders */}
      {view === 'all' && !debounced && (data?.folders?.length ?? 0) > 0 && (
        <div className="mb-5">
          <h2 className="mb-2 text-[11px] font-semibold tracking-[0.08em] text-faint uppercase">Folders</h2>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {data!.folders.map((folder) => (
              <button
                key={folder.id}
                onClick={() => navigate(`/drive?folder=${folder.id}`)}
                onDoubleClick={() => navigate(`/drive?folder=${folder.id}`)}
                className="group flex items-center gap-2.5 rounded-xl border border-line bg-panel px-3 py-2.5 text-left transition hover:border-strong hover:bg-panel-2"
              >
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-lg"
                  style={{ background: `${FOLDER_COLORS[folder.color] ?? FOLDER_COLORS.indigo}22` }}
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" style={{ color: FOLDER_COLORS[folder.color] ?? FOLDER_COLORS.indigo }} stroke="currentColor" strokeWidth="1.9">
                    <path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z" />
                  </svg>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-body">{folder.name}</span>
                  <span className="block text-[11px] text-faint">{folder.fileCount} {folder.fileCount === 1 ? 'file' : 'files'}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Files */}
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold tracking-[0.08em] text-faint uppercase">Files</h2>
        <div className="flex items-center gap-3 text-[11px] text-faint">
          {sortButton('name', 'Name')}
          {sortButton('size', 'Size')}
          {sortButton('updated', 'Modified')}
        </div>
      </div>

      {loading && !data ? (
        <div className="space-y-1.5">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="skeleton h-12 w-full" />
          ))}
        </div>
      ) : files.length === 0 ? (
        emptyState
      ) : layout === 'list' ? (
        <div className="overflow-hidden rounded-xl border border-line bg-panel">
          <div className="hidden items-center gap-3 border-b border-line px-3 py-2 text-[11px] font-medium text-faint sm:flex">
            <input
              type="checkbox"
              checked={selected.size === files.length && files.length > 0}
              onChange={selectAll}
              className="size-3.5 accent-[var(--accent)]"
              aria-label="Select all"
            />
            <span className="flex-1">Name</span>
            <span className="hidden w-32 md:block">Account</span>
            <span className="w-20 text-right">Size</span>
            <span className="w-24 text-right">Modified</span>
            <span className="w-7" />
          </div>
          {files.map((file, index) => {
            const isSelected = selected.has(file.id)
            return (
              <div
                key={file.id}
                onContextMenu={(event) => {
                  event.preventDefault()
                  if (!isSelected) setSelected(new Set([file.id]))
                  setMenu({ x: event.clientX, y: event.clientY, file })
                }}
                onDoubleClick={() => openFile(file)}
                className={`row-hover group flex cursor-default items-center gap-3 border-b border-line px-3 py-2 transition last:border-0 ${
                  isSelected ? 'bg-accent-soft' : ''
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => {}}
                  onClick={(event) => toggleSelect(file, index, event)}
                  className="size-3.5 shrink-0 accent-[var(--accent)]"
                  aria-label={`Select ${file.name}`}
                />
                <span className="shrink-0">
                  <FileTile kind={file.kind} size={30} />
                </span>
                <button className="min-w-0 flex-1 text-left" onClick={() => openFile(file)} title={file.name}>
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[13px] font-medium text-body">{file.name}</span>
                    {file.starred && <Star size={11} className="shrink-0 fill-current text-amber-400" />}
                    {file.shared && <Link2 size={11} className="shrink-0 text-accent" />}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint sm:hidden">
                    {formatBytes(file.sizeBytes)} · {timeAgo(file.updatedAt)}
                  </span>
                </button>
                <span className="hidden w-32 md:block">
                  <Chip>{file.accountLabel}</Chip>
                </span>
                <span className="w-20 text-right text-[11.5px] tabular-nums text-dim">{formatBytes(file.sizeBytes)}</span>
                <span className="hidden w-24 text-right text-[11.5px] text-faint sm:block">{timeAgo(file.updatedAt)}</span>
                <button
                  className="rounded p-1 text-faint opacity-0 transition group-hover:opacity-100 hover:bg-panel-3 hover:text-body focus:opacity-100"
                  onClick={(event) => {
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                    setSelected(new Set([file.id]))
                    setMenu({ x: rect.left, y: rect.bottom + 4, file })
                  }}
                  aria-label="File actions"
                >
                  <MoreVertical size={15} />
                </button>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {files.map((file, index) => {
            const isSelected = selected.has(file.id)
            const visual = fileVisual(file.kind)
            return (
              <div
                key={file.id}
                onContextMenu={(event) => {
                  event.preventDefault()
                  if (!isSelected) setSelected(new Set([file.id]))
                  setMenu({ x: event.clientX, y: event.clientY, file })
                }}
                onDoubleClick={() => openFile(file)}
                onClick={(event) => toggleSelect(file, index, event)}
                className={`group relative cursor-default overflow-hidden rounded-xl border bg-panel transition hover:border-strong ${
                  isSelected ? 'border-[var(--accent)] ring-2 ring-[var(--accent-soft)]' : 'border-line'
                }`}
              >
                <div className="relative flex h-28 items-center justify-center overflow-hidden" style={{ background: visual.bg }}>
                  {file.kind === 'image' ? (
                    <img
                      src={contentUrl(file.id)}
                      alt={file.name}
                      loading="lazy"
                      className="size-full object-cover transition duration-300 group-hover:scale-[1.03]"
                    />
                  ) : (
                    <FileIcon kind={file.kind} size={30} />
                  )}
                  <span className="absolute top-1.5 left-1.5">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}}
                      onClick={(event) => {
                        event.stopPropagation()
                        toggleSelect(file, index, event)
                      }}
                      className={`size-3.5 accent-[var(--accent)] transition ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                      aria-label={`Select ${file.name}`}
                    />
                  </span>
                  {file.kind !== 'image' && (
                    <span className="absolute right-1.5 bottom-1.5 rounded bg-black/25 px-1 py-0.5 text-[9px] font-bold text-white/90">
                      {extLabel(file.name)}
                    </span>
                  )}
                </div>
                <div className="px-2.5 py-2">
                  <p className="truncate text-[12.5px] font-medium text-body" title={file.name}>
                    {file.name}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-[10.5px] text-faint">
                    <span>{formatBytes(file.sizeBytes)}</span>
                    <span>·</span>
                    <span className="truncate">{file.accountLabel}</span>
                  </p>
                </div>
                <button
                  className="absolute top-1.5 right-1.5 rounded-md bg-black/40 p-1 text-white opacity-0 transition group-hover:opacity-100"
                  onClick={(event) => {
                    event.stopPropagation()
                    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
                    setMenu({ x: rect.left, y: rect.bottom + 4, file })
                  }}
                  aria-label="File actions"
                >
                  <MoreVertical size={13} />
                </button>
              </div>
            )
          })}
        </div>
      )}

      {/* Load more */}
      {data && files.length < data.total && (
        <div className="mt-4 flex justify-center">
          <button className="btn btn-outline" disabled={loading} onClick={() => setOffset(offset + PAGE_SIZE)}>
            {loading ? <Spinner size={14} /> : null}
            Load more ({data.total - files.length} left)
          </button>
        </div>
      )}

      {/* Empty trash */}
      {view === 'trash' && files.length > 0 && (
        <div className="mt-4 flex justify-end">
          <button
            className="btn btn-danger btn-sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const result = await api.post<{ affected: number }>('/api/files/empty-trash')
                toast({ title: `Permanently deleted ${result.affected} files`, tone: 'success' })
                await load()
                emit('refresh')
              } finally {
                setBusy(false)
              }
            }}
          >
            <Trash2 size={13} /> Empty trash
          </button>
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.file)} onClose={() => setMenu(null)} />}

      <PreviewModal
        file={previewIndex !== null ? (files[previewIndex] ?? null) : null}
        onClose={() => setPreviewIndex(null)}
        onPrev={previewIndex !== null && previewIndex > 0 ? () => setPreviewIndex(previewIndex - 1) : undefined}
        onNext={
          previewIndex !== null && previewIndex < files.length - 1 ? () => setPreviewIndex(previewIndex + 1) : undefined
        }
      />

      {/* Rename */}
      <Modal open={Boolean(renaming)} onClose={() => setRenaming(null)} title="Rename file" width="max-w-md">
        <form
          onSubmit={async (event) => {
            event.preventDefault()
            if (!renaming || !renameValue.trim()) return
            setBusy(true)
            try {
              await api.patch(`/api/files/${renaming.id}`, { name: renameValue.trim() })
              setRenaming(null)
              await load()
              toast({ title: 'Renamed', tone: 'success' })
            } catch (err) {
              toast({ title: 'Rename failed', description: (err as Error).message, tone: 'error' })
            } finally {
              setBusy(false)
            }
          }}
        >
          <input autoFocus className="input" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} />
          <div className="mt-4 flex justify-end gap-2">
            <button type="button" className="btn btn-outline" onClick={() => setRenaming(null)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Spinner size={14} /> : null} Save
            </button>
          </div>
        </form>
      </Modal>

      {/* Move */}
      <Modal
        open={Boolean(moving)}
        onClose={() => setMoving(null)}
        title={`Move ${moving?.length ?? 0} ${moving?.length === 1 ? 'file' : 'files'}`}
        description="Choose a destination folder."
      >
        <div className="grid max-h-72 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
          <button
            className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-left text-[13px] transition hover:bg-panel-2"
            onClick={() => void bulk('move', { folderId: null }, 'Moved')}
          >
            <FolderPlus size={14} className="text-faint" /> Root
          </button>
          {folders.map((folder) => (
            <button
              key={folder.id}
              className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2 text-left text-[13px] transition hover:bg-panel-2"
              onClick={() => void bulk('move', { folderId: folder.id }, 'Moved')}
            >
              <span className="size-1.5 rounded-full" style={{ background: FOLDER_COLORS[folder.color] ?? FOLDER_COLORS.indigo }} />
              <span className="truncate">{folder.name}</span>
            </button>
          ))}
        </div>
      </Modal>
    </div>
  )
}
