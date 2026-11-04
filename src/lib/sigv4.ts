import { createHash, createHmac } from 'node:crypto'

/**
 * AWS Signature V4, hand-rolled.
 *
 * The official SDK pulls in ~40 MB of modules and a middleware stack for what is
 * ultimately a few HMAC operations. These ~150 lines sign and send the five
 * requests a storage gateway actually needs (PUT, GET, DELETE, HEAD, POST), and
 * because bodies are streamed with UNSIGNED-PAYLOAD we never buffer a file to
 * compute a hash — which is what keeps large uploads at wire speed.
 */

export type S3Config = {
  bucket: string
  region: string
  endpoint?: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle?: boolean
  prefix?: string
  quotaBytes?: number | null
}

const ALGORITHM = 'AWS4-HMAC-SHA256'
const UNSIGNED = 'UNSIGNED-PAYLOAD'

const sha256Hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const hmac = (key: Buffer | string, value: string) => createHmac('sha256', key).update(value).digest()

/** RFC 3986 encoding — encodeURIComponent leaves !'()* alone, S3 does not want that. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())
}

function encodeKeyPath(key: string): string {
  return key
    .split('/')
    .map((segment) => uriEncode(segment))
    .join('/')
}

function amzDate(now = new Date()): { date: string; stamp: string } {
  const stamp = now.toISOString().replace(/[:-]|\.\d{3}/g, '')
  return { date: stamp.slice(0, 8), stamp }
}

export type SignedRequest = {
  url: string
  headers: Record<string, string>
}

type SignOptions = {
  config: S3Config
  method: 'GET' | 'PUT' | 'DELETE' | 'HEAD' | 'POST'
  /** Object key relative to the bucket (already includes prefix). */
  key?: string
  query?: Record<string, string>
  /** Headers that must be part of the signature (host is always included). */
  headers?: Record<string, string>
  /** Injected clock — makes the signature deterministic in tests. */
  now?: Date
  /**
   * Payload hash used in the canonical request. Defaults to UNSIGNED-PAYLOAD,
   * which lets us stream bodies of unknown content without hashing them first.
   */
  payloadHash?: string
}

function endpointFor(config: S3Config, key?: string): { url: URL; host: string; path: string } {
  const pathStyle = config.forcePathStyle ?? Boolean(config.endpoint)
  const keyPath = key ? '/' + encodeKeyPath(key) : ''

  if (config.endpoint) {
    const base = new URL(config.endpoint)
    if (pathStyle) {
      const joined = `/${config.bucket}${keyPath}`
      return { url: new URL(joined, base.origin), host: base.host, path: joined }
    }
    const host = `${config.bucket}.${base.host}`
    return { url: new URL(keyPath || '/', `${base.protocol}//${host}`), host, path: keyPath || '/' }
  }

  const host = `${config.bucket}.s3.${config.region}.amazonaws.com`
  return { url: new URL(keyPath || '/', `https://${host}`), host, path: keyPath || '/' }
}

export function signRequest({
  config,
  method,
  key,
  query,
  headers = {},
  now,
  payloadHash = UNSIGNED,
}: SignOptions): SignedRequest {
  const { url, host, path } = endpointFor(config, key)
  const { date, stamp } = amzDate(now)

  const signable: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
  }
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'host') continue
    signable[name.toLowerCase()] = String(value).trim()
  }

  const signedHeaders = Object.keys(signable).sort()
  const canonicalHeaders = signedHeaders.map((h) => `${h}:${signable[h]}\n`).join('')
  const signedHeaderList = signedHeaders.join(';')

  const queryEntries = Object.entries(query ?? {})
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const canonicalQuery = queryEntries.map(([k, v]) => `${k}=${v}`).join('&')

  const canonicalRequest = [
    method,
    path,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderList,
    payloadHash,
  ].join('\n')

  const scope = `${date}/${config.region}/s3/aws4_request`
  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${config.secretAccessKey}`, date)
  const kRegion = hmac(kDate, config.region)
  const kService = hmac(kRegion, 's3')
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  const finalUrl = new URL(url.toString())
  if (canonicalQuery) finalUrl.search = canonicalQuery

  return {
    url: finalUrl.toString(),
    headers: {
      ...headers,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': stamp,
      Authorization: `${ALGORITHM} Credential=${config.accessKeyId}/${scope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`,
    },
  }
}

export function objectKey(config: S3Config, id: string, name: string): string {
  const safe = name.replace(/[^\w.\- ]+/g, '_').slice(-120)
  const base = config.prefix ? config.prefix.replace(/^\/+|\/+$/g, '') : ''
  return base ? `${base}/${id}-${safe}` : `${id}-${safe}`
}
