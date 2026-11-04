/**
 * Tiny API client.
 *
 * - access token lives in memory only (a refresh cookie does the persistence)
 * - one transparent refresh-and-retry when a token expires mid-session
 * - uploads use XHR because `fetch` still cannot report upload progress
 */

export type User = {
  id: string
  name: string
  email: string
  avatarUrl: string | null
  role: string
}

export type FileItem = {
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

export type FolderItem = {
  id: string
  name: string
  parentId: string | null
  color: string
  icon: string
  updatedAt: number
  fileCount: number
}

export type InstanceInfo = {
  needsSetup: boolean
  users: number
  signupOpen: boolean
  demoMode: boolean
  google: { configured: boolean; redirectUri: string; clientId: string | null }
  appUrl: string
  version: string
}

export type Account = {
  id: string
  provider: string
  label: string
  email: string | null
  avatarUrl: string | null
  totalBytes: number | null
  usedBytes: number
  availableBytes: number | null
  status: string
  isDemo: boolean
  priority: number
  detail: string
  lastError: string | null
  quotaSyncedAt: number | null
  createdAt: number
}

export type PoolSummary = {
  accounts: {
    id: string
    label: string
    provider: string
    usedBytes: number
    totalBytes: number | null
    availableBytes: number | null
    sharePct: number
    status: string
    isDemo: boolean
    detail: string
  }[]
  totalBytes: number | null
  usedBytes: number
  availableBytes: number | null
  usedPct: number
  accountCount: number
}

export type Share = {
  id: string
  token: string
  fileId: string
  fileName: string
  mimeType: string
  kind: string
  sizeBytes: number
  accountLabel: string
  url: string
  expiresAt: number | null
  downloads: number
  views: number
  createdAt: number
}

export type ApiKeyRecord = {
  id: string
  name: string
  prefix: string
  scopes: string[]
  lastUsedAt: number | null
  revoked: boolean
  createdAt: number
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

export class ApiError extends Error {
  status: number
  code: string
  details?: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

let accessToken: string | null = null
let refreshInFlight: Promise<User | null> | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function hasAccessToken(): boolean {
  return Boolean(accessToken)
}

async function parse(res: Response) {
  const type = res.headers.get('content-type') ?? ''
  const body = type.includes('application/json') ? await res.json().catch(() => null) : await res.text()
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } })?.error
    throw new ApiError(res.status, err?.code ?? 'REQUEST_FAILED', err?.message ?? `Request failed (${res.status})`, err?.details)
  }
  return body
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.body && !headers.has('content-type') && typeof init.body === 'string') {
    headers.set('content-type', 'application/json')
  }
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`)

  let res: Response
  try {
    res = await fetch(path, { ...init, headers, credentials: 'include' })
  } catch (err) {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check your connection.')
  }

  if (res.status === 401 && retry && !path.startsWith('/api/auth/')) {
    const user = await restoreSession()
    if (user) return request<T>(path, init, false)
  }

  return parse(res) as Promise<T>
}

/** Silently restores a session from the refresh cookie. */
export function restoreSession(): Promise<User | null> {
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = (async () => {
    try {
      const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      if (!res.ok) return null
      const data = (await res.json()) as { accessToken: string; user: User }
      accessToken = data.accessToken
      return data.user
    } catch {
      return null
    } finally {
      setTimeout(() => {
        refreshInFlight = null
      }, 0)
    }
  })()
  return refreshInFlight
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/* ------------------------------- instance -------------------------------- */

/** Public facts about this install — safe to call before signing in. */
export async function fetchInstance(): Promise<InstanceInfo> {
  const res = await fetch('/api/auth/instance', { credentials: 'include' })
  return parse(res) as Promise<InstanceInfo>
}

/* ------------------------------- auth calls ------------------------------ */

export type SessionResponse = { accessToken: string; expiresIn: number; user: User }

export async function login(email: string, password: string): Promise<SessionResponse> {
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  })
  const data = await parse(res)
  accessToken = (data as SessionResponse).accessToken
  return data as SessionResponse
}

export async function register(name: string, email: string, password: string): Promise<SessionResponse> {
  const res = await fetch('/api/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ name, email, password }),
  })
  const data = await parse(res)
  accessToken = (data as SessionResponse).accessToken
  return data as SessionResponse
}

export async function loginDemo(): Promise<SessionResponse> {
  const res = await fetch('/api/auth/demo', { method: 'POST', credentials: 'include' })
  const data = await parse(res)
  accessToken = (data as SessionResponse).accessToken
  return data as SessionResponse
}

export async function logout(): Promise<void> {
  accessToken = null
  await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {})
}

/* -------------------------------- uploads -------------------------------- */

export type UploadHandle = { abort: () => void }

export function uploadFile(
  file: File,
  options: {
    folderId?: string | null
    onProgress?: (loaded: number, total: number) => void
    onDone?: (file: FileItem, account: { label: string }) => void
    onError?: (message: string) => void
    signal?: AbortSignal
  },
): UploadHandle {
  const xhr = new XMLHttpRequest()
  const params = new URLSearchParams({ name: file.name })
  if (file.type) params.set('mime', file.type)
  if (options.folderId) params.set('folderId', options.folderId)

  xhr.open('POST', `/api/uploads?${params.toString()}`)
  xhr.withCredentials = true
  if (accessToken) xhr.setRequestHeader('authorization', `Bearer ${accessToken}`)
  xhr.setRequestHeader('content-type', file.type || 'application/octet-stream')

  xhr.upload.onprogress = (event) => {
    if (event.lengthComputable) options.onProgress?.(event.loaded, event.total)
  }

  xhr.onload = () => {
    let payload: any = null
    try {
      payload = JSON.parse(xhr.responseText)
    } catch {
      /* non-JSON */
    }
    if (xhr.status >= 200 && xhr.status < 300 && payload?.file) {
      options.onProgress?.(file.size, file.size)
      options.onDone?.(payload.file as FileItem, payload.account)
    } else {
      options.onError?.(payload?.error?.message ?? `Upload failed (${xhr.status})`)
    }
  }
  xhr.onerror = () => options.onError?.('Network error while uploading.')
  xhr.onabort = () => options.onError?.('Upload cancelled.')

  options.signal?.addEventListener('abort', () => xhr.abort(), { once: true })
  xhr.send(file)

  return { abort: () => xhr.abort() }
}

export function contentUrl(fileId: string): string {
  return `/api/files/content/${fileId}`
}

export function downloadUrl(fileId: string): string {
  return `/api/files/download/${fileId}`
}
