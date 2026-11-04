import { useEffect, useRef, useState } from 'react'
import { CloudUpload, FolderPlus, Upload } from 'lucide-react'
import { AuthProvider, ThemeProvider, ToastProvider, UploadProvider, useAuth, useUploads } from './lib/app-context'
import { emit } from './lib/bus'
import { matchPath, navigate, useLocation } from './lib/router'
import { useShellData, FOLDER_COLORS, type FolderNode } from './lib/shell-data'
import { Sidebar } from './components/sidebar'
import { Topbar } from './components/topbar'
import { UploadTray } from './components/upload-tray'
import { BrandMark } from './components/sidebar'
import { Field, Modal, Spinner } from './components/ui'
import { api } from './lib/api'
import { useToast } from './lib/app-context'
import { DrivePage } from './pages/drive'
import { LoginPage } from './pages/login'
import { AccountsPage } from './pages/accounts'
import { SharedPage } from './pages/shared'
import { ApiKeysPage } from './pages/api-keys'
import { ActivityPage } from './pages/activity'
import { SettingsPage } from './pages/settings'
import { PublicPage } from './pages/public'
import { SetupPage } from './pages/setup'

export function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <AuthProvider>
          <UploadProvider>
            <Root />
          </UploadProvider>
        </AuthProvider>
      </ToastProvider>
    </ThemeProvider>
  )
}

function Root() {
  const { user, ready } = useAuth()
  const { path } = useLocation()

  const publicMatch = matchPath('/p/:token', path)

  // Public share pages are standalone and need no session.
  if (publicMatch) return <PublicPage token={publicMatch.token} />

  // Onboarding runs its own auth handling (create the owner, then connect a
  // real Google Drive), so it sits above the signed-in/signed-out split.
  if (path === '/setup') return <SetupPage />

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center bg-app">
        <div className="flex flex-col items-center gap-3">
          <BrandMark size={40} />
          <p className="text-[12px] tracking-wide text-faint uppercase">Loading PSDrive</p>
        </div>
      </div>
    )
  }

  if (!user) {
    if (path !== '/login') {
      // Keep the URL honest without a render-phase navigation.
      window.history.replaceState({}, '', '/login')
    }
    return <LoginPage />
  }

  if (path === '/login' || path === '/') {
    return <Shell redirectTo="/drive" />
  }

  return <Shell />
}

function Shell({ redirectTo }: { redirectTo?: string }) {
  const { path, search } = useLocation()
  const { stats, folders, reload } = useShellData()
  const { enqueue, activeCount, revision } = useUploads()
  const { toast } = useToast()

  const [query, setQuery] = useState('')
  const [drawer, setDrawer] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [folderColor, setFolderColor] = useState('indigo')
  const [creating, setCreating] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  const folderId = search.get('folder')

  useEffect(() => {
    if (redirectTo) navigate(redirectTo, { replace: true })
  }, [redirectTo])

  // Clear the search box when leaving the file browser.
  useEffect(() => {
    if (!['/drive', '/recent', '/starred', '/trash'].includes(path)) setQuery('')
  }, [path])

  // Refresh the shell when an upload finishes.
  useEffect(() => {
    if (revision > 0) {
      reload()
      emit('refresh')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  const openUpload = () => fileInput.current?.click()

  const onFiles = (list: FileList | null) => {
    if (!list?.length) return
    enqueue(Array.from(list), folderId)
    emit('upload')
  }

  const createFolder = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!folderName.trim()) return
    setCreating(true)
    try {
      await api.post('/api/folders', { name: folderName.trim(), color: folderColor, parentId: folderId ?? null })
      toast({ title: 'Folder created', description: folderName.trim(), tone: 'success' })
      setFolderName('')
      setNewFolderOpen(false)
      reload()
    } catch (err) {
      toast({ title: 'Could not create folder', description: (err as Error).message, tone: 'error' })
    } finally {
      setCreating(false)
    }
  }

  const view = path === '/recent' ? 'recent' : path === '/starred' ? 'starred' : path === '/trash' ? 'trash' : 'all'
  const isFilesRoute = ['/drive', '/recent', '/starred', '/trash'].includes(path)

  return (
    <div
      className="flex h-full overflow-hidden bg-app"
      onDragEnter={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        dragDepth.current++
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) event.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        onFiles(event.dataTransfer.files)
      }}
    >
      {/* Desktop sidebar */}
      <div className="hidden lg:flex">
        <Sidebar stats={stats} folders={folders} onNewFolder={() => setNewFolderOpen(true)} onUploadClick={openUpload} />
      </div>

      {/* Mobile drawer */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <div className="animate-slide-up absolute inset-y-0 left-0 shadow-panel">
            <Sidebar
              stats={stats}
              folders={folders}
              onNewFolder={() => {
                setDrawer(false)
                setNewFolderOpen(true)
              }}
              onUploadClick={() => {
                setDrawer(false)
                openUpload()
              }}
              onClose={() => setDrawer(false)}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          query={isFilesRoute ? query : ''}
          onQueryChange={isFilesRoute ? setQuery : undefined}
          onMenuClick={() => setDrawer(true)}
          onUploadClick={openUpload}
        />

        <main className="min-h-0 flex-1 overflow-y-auto">
          {isFilesRoute ? (
            <DrivePage
              view={view}
              query={query}
              stats={stats}
              folders={folders}
              onUploadClick={openUpload}
              onNewFolder={() => setNewFolderOpen(true)}
            />
          ) : path === '/accounts' ? (
            <AccountsPage stats={stats} reload={reload} />
          ) : path === '/shared' ? (
            <SharedPage />
          ) : path === '/api' ? (
            <ApiKeysPage />
          ) : path === '/activity' ? (
            <ActivityPage />
          ) : path === '/settings' ? (
            <SettingsPage />
          ) : (
            <NotFound />
          )}
        </main>
      </div>

      <UploadTray />

      {activeCount > 0 && (
        <div className="fixed bottom-3 left-3 z-30 hidden rounded-lg border border-line bg-elevated px-2.5 py-1.5 text-[11px] text-dim shadow-panel sm:block">
          {activeCount} upload{activeCount > 1 ? 's' : ''} in progress
        </div>
      )}

      {/* Drag & drop veil */}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[80] flex items-center justify-center bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] backdrop-blur-[2px]">
          <div className="animate-pop-in rounded-2xl border-2 border-dashed border-[var(--accent)] bg-elevated/95 px-10 py-8 text-center shadow-panel">
            <CloudUpload size={32} className="mx-auto mb-3 text-accent" />
            <p className="text-sm font-semibold text-body">Drop to upload</p>
            <p className="mt-1 text-[12px] text-dim">
              Files go to {folderId ? folders.find((f: FolderNode) => f.id === folderId)?.name ?? 'this folder' : 'your drive'} · routed automatically
            </p>
          </div>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          onFiles(event.target.files)
          event.target.value = ''
        }}
      />

      <Modal open={newFolderOpen} onClose={() => setNewFolderOpen(false)} title="New folder" width="max-w-md">
        <form onSubmit={createFolder} className="space-y-3">
          <Field label="Folder name">
            <input
              className="input"
              value={folderName}
              onChange={(event) => setFolderName(event.target.value)}
              placeholder="Invoices"
              autoFocus
              required
            />
          </Field>
          <div>
            <span className="label">Colour</span>
            <div className="flex gap-2">
              {Object.entries(FOLDER_COLORS).map(([name, color]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setFolderColor(name)}
                  className={`size-6 rounded-full transition ${folderColor === name ? 'ring-2 ring-offset-2 ring-offset-[var(--panel)]' : ''}`}
                  style={{ background: color, boxShadow: folderColor === name ? `0 0 0 2px ${color}` : undefined }}
                  aria-label={name}
                />
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn btn-outline" onClick={() => setNewFolderOpen(false)}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={creating || !folderName.trim()}>
              {creating ? <Spinner size={14} /> : <FolderPlus size={14} />} Create folder
            </button>
          </div>
        </form>
      </Modal>
    </div>
  )
}

function NotFound() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-3xl font-semibold text-body">404</p>
      <p className="text-[13px] text-dim">That page does not exist.</p>
      <button className="btn btn-primary btn-sm mt-3" onClick={() => navigate('/drive')}>
        <Upload size={13} /> Back to files
      </button>
    </div>
  )
}
