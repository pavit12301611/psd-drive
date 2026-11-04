/**
 * Every backend implements the same tiny contract. Adding Dropbox, OneDrive or
 * B2 later means writing one file and registering it — nothing else changes.
 */

export type Quota = {
  total: number | null
  used: number
  available: number | null
}

export type UploadInput = {
  /** Body is streamed straight through; nothing is buffered or written to temp disk. */
  body: ReadableStream<Uint8Array>
  size: number
  name: string
  mimeType: string
  signal?: AbortSignal
}

export type StoredObject = {
  providerFileId: string
  size: number
}

export type ByteRange = { start: number; end?: number }

export type DownloadResult = {
  body: ReadableStream<Uint8Array>
  status: 200 | 206
  size: number
  contentType?: string
  contentRange?: string
  etag?: string
}

export interface StorageProvider {
  readonly type: string
  upload(input: UploadInput): Promise<StoredObject>
  download(providerFileId: string, range?: ByteRange): Promise<DownloadResult>
  remove(providerFileId: string): Promise<void>
  rename(providerFileId: string, name: string): Promise<void>
  quota(): Promise<Quota>
  /** Human label for the settings screen, e.g. the bucket name. */
  describe(): string
}
