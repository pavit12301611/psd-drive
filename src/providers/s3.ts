import { newId } from '../lib/crypto.ts'
import { badGateway } from '../lib/errors.ts'
import { objectKey, signRequest, type S3Config } from '../lib/sigv4.ts'
import type { ByteRange, DownloadResult, Quota, StorageProvider, StoredObject, UploadInput } from './types.ts'

/**
 * S3-compatible provider: AWS S3, Cloudflare R2, MinIO, Wasabi, Backblaze B2,
 * DigitalOcean Spaces, Supabase Storage — anything that speaks SigV4.
 *
 * Uploads and downloads are pure stream passthrough: bytes go from the client
 * socket to the bucket socket, never through a temp file or a memory buffer.
 */
export class S3Provider implements StorageProvider {
  readonly type = 's3'
  readonly #config: S3Config

  constructor(config: S3Config) {
    this.#config = config
  }

  async upload(input: UploadInput): Promise<StoredObject> {
    const key = objectKey(this.#config, newId(), input.name)
    const signed = signRequest({
      config: this.#config,
      method: 'PUT',
      key,
      headers: { 'content-type': input.mimeType || 'application/octet-stream' },
    })

    const res = await fetch(signed.url, {
      method: 'PUT',
      headers: {
        ...signed.headers,
        'content-type': input.mimeType || 'application/octet-stream',
        'content-length': String(input.size),
      },
      body: input.body as unknown as BodyInit,
      // @ts-expect-error — required by undici for streaming request bodies
      duplex: 'half',
      signal: input.signal,
    }).catch((err: Error) => {
      throw badGateway(`S3 upload failed: ${err.message}`)
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw badGateway(`S3 rejected the upload (${res.status}).`, detail.slice(0, 500))
    }
    await res.arrayBuffer().catch(() => {})

    return { providerFileId: key, size: input.size }
  }

  async download(providerFileId: string, range?: ByteRange): Promise<DownloadResult> {
    const headers: Record<string, string> = {}
    if (range) {
      headers.Range = `bytes=${range.start}-${range.end != null ? range.end : ''}`
    }

    const signed = signRequest({ config: this.#config, method: 'GET', key: providerFileId, headers })
    const res = await fetch(signed.url, { method: 'GET', headers: signed.headers }).catch((err: Error) => {
      throw badGateway(`S3 download failed: ${err.message}`)
    })

    if (!res.ok && res.status !== 206) {
      const detail = await res.text().catch(() => '')
      throw badGateway(`S3 returned ${res.status}.`, detail.slice(0, 500))
    }

    const lengthHeader = res.headers.get('content-length')
    const size = lengthHeader ? Number(lengthHeader) : 0

    return {
      body: res.body as ReadableStream<Uint8Array>,
      status: res.status === 206 ? 206 : 200,
      size,
      contentType: res.headers.get('content-type') ?? undefined,
      contentRange: res.headers.get('content-range') ?? undefined,
      etag: res.headers.get('etag') ?? undefined,
    }
  }

  async remove(providerFileId: string): Promise<void> {
    const signed = signRequest({ config: this.#config, method: 'DELETE', key: providerFileId })
    const res = await fetch(signed.url, { method: 'DELETE', headers: signed.headers })
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => '')
      throw badGateway(`S3 delete failed (${res.status}).`, detail.slice(0, 300))
    }
  }

  async rename(): Promise<void> {
    /* object keys are immutable; the display name lives in our database */
  }

  async quota(): Promise<Quota> {
    const total = this.#config.quotaBytes ?? null
    return { total, used: 0, available: total }
  }

  describe(): string {
    return [this.#config.bucket, this.#config.prefix].filter(Boolean).join('/')
  }
}
