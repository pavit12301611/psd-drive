import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { config } from '../config.ts'
import { newId } from '../lib/crypto.ts'
import { badGateway } from '../lib/errors.ts'
import type { ByteRange, DownloadResult, Quota, StorageProvider, StoredObject, UploadInput } from './types.ts'

/**
 * Local disk provider.
 *
 * Not just a demo toy — it is a fully functional backend for a plain
 * self-hosted drive, and it is the reference implementation of the streaming
 * contract every other provider follows.
 */
export class LocalProvider implements StorageProvider {
  readonly type = 'local'
  readonly #dir: string
  readonly #quotaBytes: number | null

  constructor(accountId: string, options: { quotaBytes?: number | null } = {}) {
    this.#dir = path.join(config.blobDir, accountId)
    this.#quotaBytes = options.quotaBytes ?? null
  }

  #objectPath(id: string): string {
    return path.join(this.#dir, path.basename(id))
  }

  async upload(input: UploadInput): Promise<StoredObject> {
    await mkdir(this.#dir, { recursive: true })
    const id = newId()
    const finalPath = this.#objectPath(id)
    const tmpPath = `${finalPath}.part`

    try {
      // Stream request bytes straight to disk — the file never sits in memory.
      await pipeline(Readable.fromWeb(input.body as never), createWriteStream(tmpPath), {
        signal: input.signal,
      })
      await rename(tmpPath, finalPath)
      const info = await stat(finalPath)
      return { providerFileId: id, size: info.size }
    } catch (err) {
      await rm(tmpPath, { force: true }).catch(() => {})
      if ((err as Error).name === 'AbortError') throw err
      throw badGateway(`Local write failed: ${(err as Error).message}`)
    }
  }

  async download(providerFileId: string, range?: ByteRange): Promise<DownloadResult> {
    const filePath = this.#objectPath(providerFileId)
    let size: number
    try {
      size = (await stat(filePath)).size
    } catch {
      throw badGateway('Stored object is missing on disk.')
    }

    if (range) {
      const start = Math.max(0, Math.min(range.start, Math.max(0, size - 1)))
      const end = Math.min(range.end ?? size - 1, size - 1)
      return {
        body: Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream<Uint8Array>,
        status: 206,
        size: end - start + 1,
        contentRange: `bytes ${start}-${end}/${size}`,
      }
    }

    return {
      body: Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>,
      status: 200,
      size,
    }
  }

  async remove(providerFileId: string): Promise<void> {
    await rm(this.#objectPath(providerFileId), { force: true })
  }

  async rename(): Promise<void> {
    /* display names live in the database; disk objects keep their opaque id */
  }

  async quota(): Promise<Quota> {
    if (this.#quotaBytes != null) {
      return { total: this.#quotaBytes, used: 0, available: this.#quotaBytes }
    }
    try {
      const fs = await statfs(config.blobDir)
      const total = fs.blocks * fs.bsize
      const free = fs.bavail * fs.bsize
      return { total, used: total - free, available: free }
    } catch {
      return { total: null, used: 0, available: null }
    }
  }

  describe(): string {
    return this.#quotaBytes ? 'Local disk (quota)' : 'Local disk'
  }
}

/** Used by the demo seeder to drop bytes on disk directly. */
export async function writeLocalObject(accountId: string, id: string, data: Uint8Array): Promise<void> {
  const dir = path.join(config.blobDir, accountId)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, id), data)
}
