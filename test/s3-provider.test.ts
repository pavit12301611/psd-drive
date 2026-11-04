import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { S3Provider } from '../src/providers/s3.ts'

/**
 * Drives the S3 provider against a mock bucket.
 *
 * This is the test that matters for the "no SDK" claim: it proves that a
 * streamed request body really does arrive with a Content-Length (S3 rejects
 * chunked uploads), that Range requests are forwarded, and that deletes work.
 */

type Received = { key: string; bytes: number; headers: Record<string, string | string[] | undefined> }

const objects = new Map<string, Buffer>()
const received: Received[] = []
let server: Server
let base = ''

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ''))

    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        objects.set(key, body)
        received.push({ key, bytes: body.length, headers: req.headers })
        res.writeHead(200, { etag: `"${createHash('md5').update(body).digest('hex')}"` })
        res.end()
      })
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const body = objects.get(key)
      if (!body) {
        res.writeHead(404)
        res.end()
        return
      }
      const range = req.headers.range
      if (range) {
        const match = /bytes=(\d*)-(\d*)/.exec(range)
        const start = match?.[1] ? Number(match[1]) : 0
        const end = match?.[2] ? Number(match[2]) : body.length - 1
        const slice = body.subarray(start, end + 1)
        res.writeHead(206, {
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${end}/${body.length}`,
          'content-type': 'application/octet-stream',
        })
        res.end(slice)
        return
      }
      res.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/octet-stream' })
      res.end(body)
      return
    }

    if (req.method === 'DELETE') {
      objects.delete(key)
      res.writeHead(204)
      res.end()
      return
    }

    res.writeHead(405)
    res.end()
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})

after(() => new Promise<void>((resolve) => server.close(() => resolve())))

function provider() {
  return new S3Provider({
    bucket: 'bucket',
    region: 'auto',
    endpoint: base,
    accessKeyId: 'test-key',
    secretAccessKey: 'test-secret',
    forcePathStyle: true,
    prefix: 'psdrive',
    quotaBytes: 1024 ** 3,
  })
}

test('streams an upload with a Content-Length and a signed request', async () => {
  const payload = randomBytes(512 * 1024)
  const stream = new Blob([payload]).stream()
  const result = await provider().upload({
    body: stream as ReadableStream<Uint8Array>,
    size: payload.length,
    name: 'photo of the day.jpg',
    mimeType: 'image/jpeg',
  })

  assert.equal(result.size, payload.length)
  assert.ok(result.providerFileId.startsWith('psdrive/'))

  const stored = objects.get(result.providerFileId)
  assert.ok(stored, 'object was not stored by the mock bucket')
  assert.equal(stored.length, payload.length)
  assert.ok(stored.equals(payload), 'stored bytes differ from the uploaded stream')

  const record = received.at(-1)!
  assert.equal(record.headers['content-length'], String(payload.length), 'S3 requires an explicit Content-Length')
  assert.match(String(record.headers.authorization), /^AWS4-HMAC-SHA256 Credential=/)
  assert.equal(record.headers['x-amz-content-sha256'], 'UNSIGNED-PAYLOAD')
})

test('forwards Range requests and returns 206 with a content range', async () => {
  const payload = randomBytes(64 * 1024)
  const { providerFileId } = await provider().upload({
    body: new Blob([payload]).stream() as ReadableStream<Uint8Array>,
    size: payload.length,
    name: 'range-test.bin',
    mimeType: 'application/octet-stream',
  })

  const result = await provider().download(providerFileId, { start: 1000, end: 1099 })
  assert.equal(result.status, 206)
  assert.equal(result.contentRange, `bytes 1000-1099/${payload.length}`)

  const body = Buffer.from(await new Response(result.body).arrayBuffer())
  assert.equal(body.length, 100)
  assert.ok(body.equals(payload.subarray(1000, 1100)), 'range bytes do not match the source')
})

test('downloads a whole object', async () => {
  const payload = randomBytes(4096)
  const { providerFileId } = await provider().upload({
    body: new Blob([payload]).stream() as ReadableStream<Uint8Array>,
    size: payload.length,
    name: 'whole.bin',
    mimeType: 'application/octet-stream',
  })

  const result = await provider().download(providerFileId)
  assert.equal(result.status, 200)
  const body = Buffer.from(await new Response(result.body).arrayBuffer())
  assert.ok(body.equals(payload))
})

test('deletes an object', async () => {
  const payload = randomBytes(1024)
  const { providerFileId } = await provider().upload({
    body: new Blob([payload]).stream() as ReadableStream<Uint8Array>,
    size: payload.length,
    name: 'delete-me.bin',
    mimeType: 'application/octet-stream',
  })

  await provider().remove(providerFileId)
  assert.equal(objects.has(providerFileId), false)
})

test('surfaces provider errors instead of swallowing them', async () => {
  const failing = new S3Provider({
    bucket: 'bucket',
    region: 'auto',
    endpoint: 'http://127.0.0.1:9', // discard port: connection refused
    accessKeyId: 'x',
    secretAccessKey: 'y',
    forcePathStyle: true,
  })

  await assert.rejects(
    failing.upload({
      body: new Blob([Buffer.from('hi')]).stream() as ReadableStream<Uint8Array>,
      size: 2,
      name: 'fail.txt',
      mimeType: 'text/plain',
    }),
    /S3 upload failed/i,
  )
})
