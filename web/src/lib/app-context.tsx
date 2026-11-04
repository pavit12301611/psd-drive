import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  api,
  login as apiLogin,
  loginDemo as apiLoginDemo,
  logout as apiLogout,
  register as apiRegister,
  restoreSession,
  setAccessToken,
  uploadFile,
  type FileItem,
  type SessionResponse,
  type User,
} from './api'

/* --------------------------------- theme --------------------------------- */

type Theme = 'dark' | 'light'

type ThemeContextValue = { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void }

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      const saved = localStorage.getItem('psdrive.theme')
      return saved === 'light' ? 'light' : 'dark'
    } catch {
      return 'dark'
    }
  })

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    document.documentElement.style.colorScheme = theme
    try {
      localStorage.setItem('psdrive.theme', theme)
    } catch {
      /* private mode */
    }
  }, [theme])

  const value = useMemo<ThemeContextValue>(
    () => ({
      theme,
      setTheme: setThemeState,
      toggle: () => setThemeState((current) => (current === 'dark' ? 'light' : 'dark')),
    }),
    [theme],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used inside ThemeProvider')
  return ctx
}

/* --------------------------------- toasts -------------------------------- */

type Toast = { id: number; title: string; description?: string; tone: 'success' | 'error' | 'info' }

type ToastContextValue = {
  toast: (input: { title: string; description?: string; tone?: Toast['tone'] }) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const counter = useRef(0)

  const toast = useCallback((input: { title: string; description?: string; tone?: Toast['tone'] }) => {
    const id = ++counter.current
    setToasts((list) => [...list, { id, title: input.title, description: input.description, tone: input.tone ?? 'info' }])
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 4200)
  }, [])

  const value = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-[100] flex w-full max-w-sm -translate-x-1/2 flex-col gap-2 px-4 sm:left-auto sm:right-4 sm:translate-x-0">
        {toasts.map((item) => (
          <div
            key={item.id}
            className="animate-slide-up pointer-events-auto flex items-start gap-3 rounded-xl border border-line bg-elevated px-3.5 py-3 shadow-panel"
          >
            <span
              className="mt-0.5 size-2 shrink-0 rounded-full"
              style={{
                background:
                  item.tone === 'success' ? 'var(--success)' : item.tone === 'error' ? 'var(--danger)' : 'var(--accent)',
              }}
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-body">{item.title}</p>
              {item.description && <p className="mt-0.5 text-xs leading-relaxed text-dim">{item.description}</p>}
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside ToastProvider')
  return ctx
}

/* ---------------------------------- auth --------------------------------- */

type AuthContextValue = {
  user: User | null
  ready: boolean
  signIn: (email: string, password: string) => Promise<void>
  signUp: (name: string, email: string, password: string) => Promise<void>
  signInDemo: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    restoreSession()
      .then((restored) => {
        if (!cancelled) setUser(restored)
      })
      .finally(() => {
        if (!cancelled) setReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const accept = (session: SessionResponse) => setUser(session.user)

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      ready,
      signIn: async (email, password) => accept(await apiLogin(email, password)),
      signUp: async (name, email, password) => accept(await apiRegister(name, email, password)),
      signInDemo: async () => accept(await apiLoginDemo()),
      signOut: async () => {
        await apiLogout()
        setAccessToken(null)
        setUser(null)
      },
    }),
    [user, ready],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}

/* -------------------------------- uploads -------------------------------- */

export type UploadTask = {
  id: string
  name: string
  size: number
  loaded: number
  status: 'queued' | 'uploading' | 'done' | 'error' | 'cancelled'
  error?: string
  accountLabel?: string
  startedAt?: number
  finishedAt?: number
  file: File
  folderId: string | null
}

type UploadContextValue = {
  tasks: UploadTask[]
  activeCount: number
  /** Bumped whenever a file lands, so open views can refresh. */
  revision: number
  enqueue: (files: File[], folderId: string | null) => void
  cancel: (id: string) => void
  retry: (id: string) => void
  dismiss: (id: string) => void
  clearFinished: () => void
}

const UploadContext = createContext<UploadContextValue | null>(null)

const MAX_CONCURRENT = 3

export function UploadProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<UploadTask[]>([])
  const [revision, setRevision] = useState(0)
  const { toast } = useToast()
  const running = useRef(new Set<string>())
  const aborters = useRef(new Map<string, () => void>())

  const patch = useCallback((id: string, next: Partial<UploadTask>) => {
    setTasks((list) => list.map((task) => (task.id === id ? { ...task, ...next } : task)))
  }, [])

  const start = useCallback(
    (task: UploadTask) => {
      if (running.current.has(task.id)) return
      running.current.add(task.id)
      patch(task.id, { status: 'uploading', startedAt: Date.now(), loaded: 0, error: undefined })

      const handle = uploadFile(task.file, {
        folderId: task.folderId,
        onProgress: (loaded) => patch(task.id, { loaded }),
        onDone: (file: FileItem, account) => {
          running.current.delete(task.id)
          aborters.current.delete(task.id)
          patch(task.id, {
            status: 'done',
            loaded: task.size,
            accountLabel: account?.label,
            finishedAt: Date.now(),
          })
          setRevision((r) => r + 1)
          toast({ title: 'Upload complete', description: `${file.name} → ${account?.label ?? 'storage'}`, tone: 'success' })
        },
        onError: (message) => {
          running.current.delete(task.id)
          aborters.current.delete(task.id)
          patch(task.id, {
            status: message === 'Upload cancelled.' ? 'cancelled' : 'error',
            error: message,
            finishedAt: Date.now(),
          })
          if (message !== 'Upload cancelled.') {
            toast({ title: "Upload failed", description: message, tone: 'error' })
          }
        },
      })

      aborters.current.set(task.id, () => handle.abort())
    },
    [patch, toast],
  )

  // Pump the queue: keep at most MAX_CONCURRENT uploads in flight.
  useEffect(() => {
    if (running.current.size >= MAX_CONCURRENT) return
    const next = tasks.find((task) => task.status === 'queued')
    if (next) start(next)
  }, [tasks, start])

  const enqueue = useCallback(
    (files: File[], folderId: string | null) => {
      if (!files.length) return
      const created = files.map<UploadTask>((file) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        size: file.size,
        loaded: 0,
        status: 'queued',
        file,
        folderId,
      }))
      setTasks((list) => [...list, ...created])
    },
    [],
  )

  const cancel = useCallback((id: string) => {
    aborters.current.get(id)?.()
    running.current.delete(id)
    patch(id, { status: 'cancelled' })
  }, [patch])

  const retry = useCallback((id: string) => {
    patch(id, { status: 'queued', loaded: 0, error: undefined })
  }, [patch])

  const dismiss = useCallback((id: string) => {
    setTasks((list) => list.filter((task) => task.id !== id))
  }, [])

  const clearFinished = useCallback(() => {
    setTasks((list) => list.filter((task) => task.status === 'uploading' || task.status === 'queued'))
  }, [])

  const activeCount = tasks.filter((task) => task.status === 'uploading' || task.status === 'queued').length

  const value = useMemo<UploadContextValue>(
    () => ({ tasks, activeCount, revision, enqueue, cancel, retry, dismiss, clearFinished }),
    [tasks, activeCount, revision, enqueue, cancel, retry, dismiss, clearFinished],
  )

  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>
}

export function useUploads(): UploadContextValue {
  const ctx = useContext(UploadContext)
  if (!ctx) throw new Error('useUploads must be used inside UploadProvider')
  return ctx
}

/* --------------------------------- helpers ------------------------------- */

/** Fetch JSON with loading/error state and a manual `reload`. */
export function useApi<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!path) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api
      .get<T>(path)
      .then((result) => {
        if (!cancelled) {
          setData(result)
          setError(null)
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, nonce, ...deps])

  return { data, error, loading, reload: () => setNonce((n) => n + 1), setData }
}
