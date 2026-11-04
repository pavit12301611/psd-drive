import { config } from '../config.ts'
import { HttpError, badGateway } from '../lib/errors.ts'
import type { ByteRange, DownloadResult, Quota, StorageProvider, StoredObject, UploadInput } from './types.ts'

/**
 * Google Drive provider — the real one.
 *
 * Three things make this robust against a live Google account rather than a
 * happy-path mock:
 *
 *  1. every call retries once through a forced token refresh when Google
 *     answers 401 (access tokens expire every hour, and they can be revoked);
 *  2. every failure is translated into an actionable error — "enable the Drive
 *     API", "reconnect the account", "this drive is full" — instead of a raw
 *     status code;
 *  3. account problems are reported back so the pool stops routing uploads to
 *     an account that just ran out of space or lost its grant.
 */

const DRIVE = () => config.google.driveBase
const UPLOAD_API = () => config.google.uploadBase

export type AccountProblem = { kind: 'reauth' | 'full'; message: string }

export type GoogleDeps = {
  /** Returns a valid access token, refreshing it (single-flight) when needed. */
  getAccessToken: (options?: { force?: boolean }) => Promise<string>
  /** Cached Drive folder id used as the root of every upload. */
  getAppFolderId: () => Promise<string>
  /** Called when the account itself needs attention (revoked grant, full drive). */
  report?: (problem: AccountProblem) => void
}

type GoogleErrorBody = {
  error?:
    | string
    | {
        message?: string
        status?: string
        errors?: { reason?: string; message?: string }[]
        details?: { reason?: string }[]
      }
  error_description?: string
}

/** Turn a Google error payload into an error a human can act on. */
export async function googleFailure(res: Response, what: string): Promise<HttpError> {
  const text = await res.text().catch(() => '')
  let reason = ''
  let message = text.slice(0, 400)
  let oauthError = ''

  try {
    const body = JSON.parse(text) as GoogleErrorBody
    if (typeof body.error === 'string') {
      oauthError = body.error
      message = body.error_description || body.error
    } else if (body.error) {
      message = body.error.message || message
      reason = body.error.errors?.[0]?.reason || body.error.details?.[0]?.reason || body.error.status || ''
    }
  } catch {
    /* not JSON — keep the raw text */
  }

  const haystack = `${reason} ${message} ${text}`

  if (res.status === 401 || oauthError === 'invalid_grant' || oauthError === 'invalid_token') {
    return new HttpError(
      401,
      'GOOGLE_REAUTH',
      'Google rejected the stored credentials. Reconnect this account from the Storage page.',
      { google: message.slice(0, 200) },
    )
  }

  if (res.status === 403 && /storageQuotaExceeded|quotaExceeded/i.test(haystack)) {
    return new HttpError(507, 'STORAGE_FULL', 'This Google Drive account is out of space.')
  }

  if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED|has not been used in project|drive\.googleapis\.com/i.test(haystack)) {
    return new HttpError(
      400,
      'DRIVE_API_DISABLED',
      'The Google Drive API is not enabled for this OAuth project. Enable it in Google Cloud Console (APIs & Services → Library → Google Drive API), wait a minute, then reconnect the account.',
      { google: message.slice(0, 200) },
    )
  }

  if (res.status === 403 && /insufficientPermissions|insufficientFilePermissions|PERMISSION_DENIED/i.test(haystack)) {
    return new HttpError(
      403,
      'GOOGLE_SCOPE',
      'Google denied access. Reconnect the account and keep the "See, edit, create and delete files in your Google Drive" permission ticked.',
      { google: message.slice(0, 200) },
    )
  }

  if (res.status === 403 && /rateLimitExceeded|userRateLimitExceeded|dailyLimitExceeded/i.test(haystack)) {
    return new HttpError(429, 'GOOGLE_RATE_LIMIT', 'Google is rate limiting this account. Try again in a moment.')
  }

  if (res.status === 404) {
    return new HttpError(404, 'GOOGLE_NOT_FOUND', `Google Drive no longer has this file (${what}).`, {
      google: message.slice(0, 200),
    })
  }

  return badGateway(`Google Drive ${what} failed (${res.status}).`, message.slice(0, 400))
}

/** Quote a value for the `q` search parameter. */
function driveQuery(name: string): string {
  return `'${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

export class GoogleProvider implements StorageProvider {
  readonly type = 'google'
  readonly #deps: GoogleDeps

  constructor(deps: GoogleDeps) {
    this.#deps = deps
  }

  /**
   * Run an authorized request, refreshing the token and retrying exactly once
   * when Google says the token is no longer good.
   */
  async #authed(make: (token: string) => Promise<Response>): Promise<Response> {
    let res = await make(await this.#deps.getAccessToken())
    if (res.status !== 401) return res

    // Drop the rejected response before spending a refresh on the retry.
    await res.body?.cancel().catch(() => {})
    res = await make(await this.#deps.getAccessToken({ force: true }))
    return res
  }

  /** Prove a token works and hand back the Drive identity + quota in one call. */
  static async inspect(token: string): Promise<{
    email: string | null
    name: string | null
    quota: { total: number | null; used: number; available: number | null }
  }> {
    const res = await fetch(
      `${DRIVE()}/about?fields=user(displayName,emailAddress),storageQuota(limit,usage)`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (!res.ok) throw await googleFailure(res, 'account check')

    const data = (await res.json()) as {
      user?: { displayName?: string; emailAddress?: string }
      storageQuota?: { limit?: string; usage?: string }
    }

    const total = data.storageQuota?.limit ? Number(data.storageQuota.limit) : null
    const used = data.storageQuota?.usage ? Number(data.storageQuota.usage) : 0

    return {
      email: data.user?.emailAddress ?? null,
      name: data.user?.displayName ?? null,
      quota: { total, used, available: total == null ? null : Math.max(0, total - used) },
    }
  }

  /** Find (or create once) the Drive folder that holds every upload. */
  static async ensureAppFolder(token: string): Promise<string> {
    const folderName = config.google.appFolder
    const q = encodeURIComponent(`name=${driveQuery(folderName)} and mimeType='application/vnd.google-apps.folder' and trashed=false`)
    const search = await fetch(
      `${DRIVE()}/files?q=${q}&fields=files(id)&spaces=drive&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`,
      { headers: { authorization: `Bearer ${token}` } },
    )
    if (!search.ok) throw await googleFailure(search, 'folder lookup')
    const found = (await search.json()) as { files?: { id: string }[] }
    if (found.files?.length) return found.files[0].id

    const create = await fetch(`${DRIVE()}/files?fields=id&supportsAllDrives=true`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
        parents: ['root'],
      }),
    })
    if (!create.ok) throw await googleFailure(create, 'folder creation')
    const created = (await create.json()) as { id: string }
    return created.id
  }

  async upload(input: UploadInput): Promise<StoredObject> {
    const folderId = await this.#deps.getAppFolderId()

    // 1. Open a resumable session. Google answers with a one-time upload URL.
    //    Opening the session costs no bandwidth, so a 401 or a "drive full"
    //    here is safe to retry — the body has not been read yet.
    const session = await this.#authed(async (accessToken) =>
      fetch(`${UPLOAD_API()}/files?uploadType=resumable&fields=id,size&supportsAllDrives=true`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': input.mimeType || 'application/octet-stream',
          'x-upload-content-length': String(input.size),
        },
        body: JSON.stringify({ name: input.name, parents: [folderId] }),
      }),
    )

    if (!session.ok) {
      const error = await googleFailure(session, 'upload session')
      if (error.code === 'STORAGE_FULL') {
        this.#deps.report?.({ kind: 'full', message: error.message })
      } else if (error.code === 'GOOGLE_REAUTH') {
        this.#deps.report?.({ kind: 'reauth', message: error.message })
      }
      throw error
    }

    const sessionUri = session.headers.get('location')
    if (!sessionUri) throw badGateway('Google Drive did not return an upload session.')

    // 2. Stream the body straight to Google. Exactly one pass — a failure here
    //    cannot be retried because the request stream is already consumed.
    // The session URL is bound to the client, not to one token, so ask the
    // cache for the current token (it may have been refreshed a moment ago).
    const accessToken = await this.#deps.getAccessToken()
    const put = await fetch(sessionUri, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': input.mimeType || 'application/octet-stream',
        'content-length': String(input.size),
      },
      body: input.body as unknown as BodyInit,
      // @ts-expect-error — undici needs this for streamed request bodies
      duplex: 'half',
      signal: input.signal,
    }).catch((err: Error) => {
      throw badGateway(`Google Drive upload failed: ${err.message}`)
    })

    if (!put.ok) {
      const error = await googleFailure(put, 'upload')
      if (error.code === 'STORAGE_FULL') this.#deps.report?.({ kind: 'full', message: error.message })
      if (error.code === 'GOOGLE_REAUTH') this.#deps.report?.({ kind: 'reauth', message: error.message })
      throw error
    }

    const file = (await put.json()) as { id: string; size?: string }
    return { providerFileId: file.id, size: file.size ? Number(file.size) : input.size }
  }

  async download(providerFileId: string, range?: ByteRange): Promise<DownloadResult> {
    const id = encodeURIComponent(providerFileId)
    const res = await this.#authed(async (token) => {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` }
      // Google honours Range on alt=media and answers 206 with content-range.
      if (range) headers.Range = `bytes=${range.start}-${range.end != null ? range.end : ''}`
      return fetch(`${DRIVE()}/files/${id}?alt=media&supportsAllDrives=true`, { headers })
    })

    if (!res.ok && res.status !== 206) throw await googleFailure(res, 'download')

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
    const id = encodeURIComponent(providerFileId)
    // Permanent delete: PSDrive keeps its own recycle bin, and trashing would
    // leave the bytes counted against the user's Drive quota forever.
    const res = await this.#authed((token) =>
      fetch(`${DRIVE()}/files/${id}?supportsAllDrives=true`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      }),
    )
    if (res.ok || res.status === 404) return
    throw await googleFailure(res, 'delete')
  }

  async rename(providerFileId: string, name: string): Promise<void> {
    const id = encodeURIComponent(providerFileId)
    const res = await this.#authed((token) =>
      fetch(`${DRIVE()}/files/${id}?fields=id&supportsAllDrives=true`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      }),
    )
    if (!res.ok) throw await googleFailure(res, 'rename')
  }

  async quota(): Promise<Quota> {
    const res = await this.#authed((token) =>
      fetch(`${DRIVE()}/about?fields=storageQuota`, { headers: { authorization: `Bearer ${token}` } }),
    )
    if (!res.ok) throw await googleFailure(res, 'quota lookup')

    const data = (await res.json()) as {
      storageQuota?: { limit?: string; usage?: string; usageInDriveTrash?: string }
    }
    const quota = data.storageQuota ?? {}
    // `limit` is absent for unlimited Workspace drives — report that honestly
    // as "unknown total, known usage" instead of inventing a number.
    const total = quota.limit ? Number(quota.limit) : null
    const used = quota.usage ? Number(quota.usage) : 0
    return { total, used, available: total == null ? null : Math.max(0, total - used) }
  }

  describe(): string {
    return 'Google Drive'
  }
}
