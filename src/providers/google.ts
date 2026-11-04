import { badGateway } from '../lib/errors.ts'
import type { ByteRange, DownloadResult, Quota, StorageProvider, StoredObject, UploadInput } from './types.ts'

const DRIVE = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
const APP_FOLDER = 'PSDrive'

type GoogleDeps = {
  /** Returns a valid access token, refreshing it (single-flight) when needed. */
  getAccessToken: () => Promise<string>
  /** Cached Drive folder id used as the root of every upload. */
  getAppFolderId: () => Promise<string>
}

async function jsonOrThrow<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw badGateway(`Google Drive ${what} failed (${res.status}).`, detail.slice(0, 500))
  }
  return (await res.json()) as T
}

export class GoogleProvider implements StorageProvider {
  readonly type = 'google'
  readonly #deps: GoogleDeps

  constructor(deps: GoogleDeps) {
    this.#deps = deps
  }

  /** Find (or create once) the PSDrive folder that holds every upload. */
  static async ensureAppFolder(token: string): Promise<string> {
    const q = encodeURIComponent(
      `name='${APP_FOLDER}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    )
    const search = await fetch(`${DRIVE}/files?q=${q}&fields=files(id)&spaces=drive&pageSize=1`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const found = await jsonOrThrow<{ files?: { id: string }[] }>(search, 'folder lookup')
    if (found.files?.length) return found.files[0].id

    const create = await fetch(`${DRIVE}/files?fields=id`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: APP_FOLDER,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
      }),
    })
    const created = await jsonOrThrow<{ id: string }>(create, 'folder creation')
    return created.id
  }

  async upload(input: UploadInput): Promise<StoredObject> {
    const [token, folderId] = await Promise.all([this.#deps.getAccessToken(), this.#deps.getAppFolderId()])

    // 1. Open a resumable session. Google returns a one-time upload URL.
    const init = await fetch(`${UPLOAD}/files?uploadType=resumable&fields=id,size`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': input.mimeType || 'application/octet-stream',
        'x-upload-content-length': String(input.size),
      },
      body: JSON.stringify({ name: input.name, parents: [folderId] }),
    })
    if (!init.ok) {
      const detail = await init.text().catch(() => '')
      throw badGateway(`Google Drive upload session failed (${init.status}).`, detail.slice(0, 500))
    }
    const sessionUri = init.headers.get('location')
    if (!sessionUri) throw badGateway('Google Drive did not return an upload session.')

    // 2. Stream the body straight to Google.
    const put = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': input.mimeType || 'application/octet-stream',
        'content-length': String(input.size),
      },
      body: input.body as unknown as BodyInit,
      // @ts-expect-error — undici requires this for streamed request bodies
      duplex: 'half',
      signal: input.signal,
    }).catch((err: Error) => {
      throw badGateway(`Google Drive upload failed: ${err.message}`)
    })

    const file = await jsonOrThrow<{ id: string; size?: string }>(put, 'upload')
    return { providerFileId: file.id, size: file.size ? Number(file.size) : input.size }
  }

  async download(providerFileId: string, range?: ByteRange): Promise<DownloadResult> {
    const token = await this.#deps.getAccessToken()
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (range) headers.Range = `bytes=${range.start}-${range.end != null ? range.end : ''}`

    const res = await fetch(`${DRIVE}/files/${encodeURIComponent(providerFileId)}?alt=media&supportsAllDrives=true`, {
      headers,
    })
    if (!res.ok && res.status !== 206) {
      const detail = await res.text().catch(() => '')
      throw badGateway(`Google Drive download failed (${res.status}).`, detail.slice(0, 500))
    }

    const lengthHeader = res.headers.get('content-length')
    return {
      body: res.body as ReadableStream<Uint8Array>,
      status: res.status === 206 ? 206 : 200,
      size: lengthHeader ? Number(lengthHeader) : 0,
      contentType: res.headers.get('content-type') ?? undefined,
      contentRange: res.headers.get('content-range') ?? undefined,
    }
  }

  async remove(providerFileId: string): Promise<void> {
    const token = await this.#deps.getAccessToken()
    const res = await fetch(`${DRIVE}/files/${encodeURIComponent(providerFileId)}?supportsAllDrives=true`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    })
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => '')
      throw badGateway(`Google Drive delete failed (${res.status}).`, detail.slice(0, 300))
    }
  }

  async rename(providerFileId: string, name: string): Promise<void> {
    const token = await this.#deps.getAccessToken()
    const res = await fetch(`${DRIVE}/files/${encodeURIComponent(providerFileId)}?fields=id`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    if (!res.ok) throw badGateway(`Google Drive rename failed (${res.status}).`)
  }

  async quota(): Promise<Quota> {
    const token = await this.#deps.getAccessToken()
    const res = await fetch(`${DRIVE}/about?fields=storageQuota`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const data = await jsonOrThrow<{
      storageQuota?: { limit?: string; usage?: string; usageInDriveTrash?: string }
    }>(res, 'quota lookup')

    const quota = data.storageQuota ?? {}
    const total = quota.limit ? Number(quota.limit) : null
    const used = quota.usage ? Number(quota.usage) : 0
    return { total, used, available: total == null ? null : Math.max(0, total - used) }
  }

  describe(): string {
    return 'Google Drive'
  }
}
