import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

/**
 * A spec-shaped stand-in for Google's OAuth + Drive endpoints.
 *
 * This exists so the *real* Google code path — consent redirect, code exchange,
 * token refresh, resumable upload, range download, quota lookup, revoked-grant
 * handling — is exercised end to end in CI without a live Google account. The
 * provider talks to it exactly as it talks to googleapis.com; only the base
 * URLs change.
 */

export type MockGoogle = {
  origin: string
  env: Record<string, string>
  /** Invalidate the current access token, as if it had expired. */
  expireAccessToken: () => void
  /** Make every refresh attempt fail with invalid_grant. */
  revokeGrant: () => void
  /** Usage Google will report from /about. */
  setQuota: (limit: number | null, usage: number) => void
  stats: () => { refreshes: number; uploads: number; downloads: number; deletes: number }
  files: () => { id: string; name: string; size: number; parents: string[]; mimeType: string }[]
  close: () => Promise<void>
}

type StoredFile = { id: string; name: string; mimeType: string; bytes: Buffer; parents: string[] }
type UploadSession = { name: string; mimeType: string; parents: string[] }

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': String(payload.length), ...headers })
  res.end(payload)
}

function googleError(res: ServerResponse, status: number, reason: string, message: string) {
  send(res, status, { error: { code: status, message, errors: [{ reason, message }], status: 'FAILED_PRECONDITION' } })
}

export async function startMockGoogle(): Promise<MockGoogle> {
  const files = new Map<string, StoredFile>()
  const sessions = new Map<string, UploadSession>()
  const validTokens = new Set<string>()
  const counters = { refreshes: 0, uploads: 0, downloads: 0, deletes: 0 }

  let quota: { limit: number | null; usage: number } = { limit: 16_106_127_360, usage: 1_073_741_824 }
  let refreshToken = 'rt-1'
  let revokeGrant = false
  let tokenCounter = 1

  const issueAccessToken = () => {
    const token = `at-${++tokenCounter}`
    validTokens.add(token)
    return token
  }

  const initialToken = issueAccessToken()

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://mock')
      const path = url.pathname

      /* ----------------------------- OAuth ----------------------------- */

      if (path === '/o/oauth2/v2/auth') {
        const redirect = url.searchParams.get('redirect_uri')!
        const state = url.searchParams.get('state')!
        const target = new URL(redirect)
        target.searchParams.set('code', 'auth-code-1')
        target.searchParams.set('state', state)
        target.searchParams.set('scope', 'https://www.googleapis.com/auth/drive openid email profile')
        res.writeHead(302, { location: target.toString() })
        return res.end()
      }

      if (path === '/token') {
        const body = new URLSearchParams((await readBody(req)).toString())
        const grant = body.get('grant_type')

        if (grant === 'authorization_code') {
          if (body.get('code') !== 'auth-code-1') {
            return send(res, 400, { error: 'invalid_grant', error_description: 'Bad authorization code.' })
          }
          return send(res, 200, {
            access_token: initialToken,
            refresh_token: refreshToken,
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/drive openid email profile',
            token_type: 'Bearer',
          })
        }

        if (grant === 'refresh_token') {
          if (revokeGrant || body.get('refresh_token') !== refreshToken) {
            return send(res, 400, {
              error: 'invalid_grant',
              error_description: 'Token has been expired or revoked.',
            })
          }
          counters.refreshes++
          return send(res, 200, {
            access_token: issueAccessToken(),
            expires_in: 3600,
            scope: 'https://www.googleapis.com/auth/drive openid email profile',
            token_type: 'Bearer',
          })
        }

        return send(res, 400, { error: 'unsupported_grant_type' })
      }

      if (path === '/oauth2/v2/userinfo') {
        return send(res, 200, {
          id: 'google-user-1',
          email: 'real.person@example.com',
          name: 'Real Person',
          picture: 'https://example.com/avatar.png',
        })
      }

      /* ------------------------------ Drive ---------------------------- */

      if (path.startsWith('/drive/v3/') || path === '/drive/v3') {
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        if (!validTokens.has(bearer)) {
          return googleError(res, 401, 'authError', 'Invalid Credentials')
        }

        if (path === '/drive/v3/about') {
          return send(res, 200, {
            user: { displayName: 'Real Person', emailAddress: 'real.person@example.com' },
            storageQuota: {
              ...(quota.limit == null ? {} : { limit: String(quota.limit) }),
              usage: String(quota.usage),
            },
          })
        }

        if (path === '/drive/v3/files' && req.method === 'GET') {
          const q = url.searchParams.get('q') ?? ''
          const match = /name='([^']+)'/.exec(q)
          const wanted = match?.[1]
          const hits = [...files.values()]
            .filter((file) => file.mimeType === 'application/vnd.google-apps.folder')
            .filter((file) => (wanted ? file.name === wanted : true))
            .map((file) => ({ id: file.id }))
          return send(res, 200, { files: hits.slice(0, 1) })
        }

        if (path === '/drive/v3/files' && req.method === 'POST') {
          const body = JSON.parse((await readBody(req)).toString() || '{}')
          const id = randomUUID()
          files.set(id, {
            id,
            name: body.name,
            mimeType: body.mimeType ?? 'application/octet-stream',
            bytes: Buffer.alloc(0),
            parents: body.parents ?? [],
          })
          return send(res, 200, { id })
        }

        const mediaMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path)
        if (mediaMatch) {
          const id = decodeURIComponent(mediaMatch[1])
          const file = files.get(id)
          if (!file) return googleError(res, 404, 'notFound', 'File not found.')

          if (req.method === 'GET' && url.searchParams.get('alt') === 'media') {
            counters.downloads++
            const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
            if (range) {
              const start = Number(range[1])
              const end = range[2] ? Number(range[2]) : file.bytes.length - 1
              const slice = file.bytes.subarray(start, end + 1)
              res.writeHead(206, {
                'content-type': file.mimeType,
                'content-length': String(slice.length),
                'content-range': `bytes ${start}-${end}/${file.bytes.length}`,
              })
              return res.end(slice)
            }
            res.writeHead(200, { 'content-type': file.mimeType, 'content-length': String(file.bytes.length) })
            return res.end(file.bytes)
          }

          if (req.method === 'DELETE') {
            counters.deletes++
            files.delete(id)
            res.writeHead(204)
            return res.end()
          }

          if (req.method === 'PATCH') {
            const body = JSON.parse((await readBody(req)).toString() || '{}')
            file.name = body.name ?? file.name
            return send(res, 200, { id })
          }
        }

        return googleError(res, 404, 'notFound', `No Drive route for ${req.method} ${path}`)
      }

      /* -------------------------- Resumable upload --------------------- */

      if (path === '/upload/drive/v3/files') {
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '')
        if (!validTokens.has(bearer)) return googleError(res, 401, 'authError', 'Invalid Credentials')
        if (quota.limit != null && quota.usage >= quota.limit) {
          return googleError(res, 403, 'storageQuotaExceeded', 'The user has exceeded their Drive storage quota.')
        }

        const meta = JSON.parse((await readBody(req)).toString() || '{}')
        const sessionId = randomUUID()
        sessions.set(sessionId, {
          name: meta.name,
          mimeType: req.headers['x-upload-content-type'] as string,
          parents: meta.parents ?? [],
        })
        res.writeHead(200, {
          location: `http://${req.headers.host}/upload-session/${sessionId}`,
          'content-length': '0',
        })
        return res.end()
      }

      const sessionMatch = /^\/upload-session\/([^/]+)$/.exec(path)
      if (sessionMatch && req.method === 'PUT') {
        const session = sessions.get(sessionMatch[1])
        if (!session) return send(res, 404, { error: { message: 'Unknown session' } })

        const bytes = await readBody(req)
        const id = randomUUID()
        files.set(id, { id, name: session.name, mimeType: session.mimeType, bytes, parents: session.parents })
        sessions.delete(sessionMatch[1])
        counters.uploads++
        return send(res, 200, { id, size: String(bytes.length) })
      }

      googleError(res, 404, 'notFound', `Mock Google has no route for ${req.method} ${path}`)
    })().catch((err) => {
      send(res, 500, { error: { message: (err as Error).message } })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const origin = `http://127.0.0.1:${port}`

  return {
    origin,
    env: {
      GOOGLE_AUTH_URL: `${origin}/o/oauth2/v2/auth`,
      GOOGLE_TOKEN_URL: `${origin}/token`,
      GOOGLE_USERINFO_URL: `${origin}/oauth2/v2/userinfo`,
      GOOGLE_DRIVE_BASE: `${origin}/drive/v3`,
      GOOGLE_UPLOAD_BASE: `${origin}/upload/drive/v3`,
    },
    expireAccessToken: () => {
      validTokens.clear()
    },
    revokeGrant: () => {
      revokeGrant = true
    },
    setQuota: (limit, usage) => {
      quota = { limit, usage }
    },
    stats: () => ({ ...counters }),
    files: () => [...files.values()].map(({ id, name, bytes, parents, mimeType }) => ({ id, name, size: bytes.length, parents, mimeType })),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
