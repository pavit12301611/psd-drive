import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Hono } from 'hono'
import { compress } from 'hono/compress'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import { serveStatic } from '@hono/node-server/serve-static'
import { ZodError } from 'zod'
import { config } from './config.ts'
import { HttpError } from './lib/errors.ts'
import { log } from './lib/logger.ts'
import { dbInfo } from './db/schema.ts'
import { authRouter } from './routes/auth.ts'
import { accountsRouter } from './routes/accounts.ts'
import { apiKeysRouter } from './routes/api-keys.ts'
import { filesRouter } from './routes/files.ts'
import { foldersRouter } from './routes/folders.ts'
import { uploadsRouter } from './routes/uploads.ts'
import { oauthRouter } from './routes/oauth.ts'
import { publicRouter, sharesRouter } from './routes/shares.ts'
import { activityRouter, settingsRouter, statsRouter } from './routes/misc.ts'
import { v1Router } from './routes/v1.ts'

export const app = new Hono()

/* ------------------------------ middleware ------------------------------ */

app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID().slice(0, 8)
  c.set('requestId', requestId)
  c.header('x-request-id', requestId)
  const started = performance.now()
  await next()
  const ms = performance.now() - started
  if (!c.req.path.startsWith('/assets/')) {
    const meta = { status: c.res.status, ms: Math.round(ms * 10) / 10 }
    if (ms > 750) log.warn(`${c.req.method} ${c.req.path}`, meta)
    else log.debug(`${c.req.method} ${c.req.path}`, meta)
  }
})

/**
 * The built index.html contains one small inline script (the theme bootstrap
 * that prevents a flash of the wrong theme). Rather than relaxing the policy
 * with 'unsafe-inline', we hash the exact script at boot and allow that hash.
 */
function inlineScriptHashes(indexHtml: string): string {
  const matches = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
  return matches
    .map((match) => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`)
    .join(' ')
}

const indexHtmlPath = path.join(config.webDist, 'index.html')
const scriptHashes = existsSync(indexHtmlPath)
  ? inlineScriptHashes(readFileSync(indexHtmlPath, 'utf8'))
  : ''

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self'${scriptHashes ? ' ' + scriptHashes : ''}`,
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "form-action 'self'",
].join('; ')

app.use('*', async (c, next) => {
  await next()
  c.header('x-content-type-options', 'nosniff')
  c.header('referrer-policy', 'strict-origin-when-cross-origin')
  c.header('permissions-policy', 'camera=(), microphone=(), geolocation=()')
  if (!c.req.path.startsWith('/p/')) {
    c.header('x-frame-options', 'SAMEORIGIN')
    c.header('content-security-policy', CSP)
  }
})

// Compress JSON/list responses. File streams are excluded: they are already
// compressed media and must not be buffered.
app.use('/api/*', async (c, next) => {
  if (/\/(content|download)$/.test(c.req.path)) return next()
  return compress()(c, next)
})

// The machine API is called from scripts and other servers.
app.use('/api/v1/*', cors({ origin: '*', allowHeaders: ['X-API-Key', 'Content-Type'], maxAge: 86400 }))

/* -------------------------------- routes -------------------------------- */

app.get('/healthz', (c) =>
  c.json({ ok: true, uptime: Math.round(process.uptime()), db: dbInfo(), version: '2.0.0' }),
)

app.route('/api/auth', authRouter)
app.route('/api/accounts', accountsRouter)
app.route('/api/files', filesRouter)
app.route('/api/folders', foldersRouter)
app.route('/api/uploads', uploadsRouter)
app.route('/api/shares', sharesRouter)
app.route('/api/api-keys', apiKeysRouter)
app.route('/api/activity', activityRouter)
app.route('/api/settings', settingsRouter)
app.route('/api/stats', statsRouter)
app.route('/api/oauth', oauthRouter)
app.route('/api/public', publicRouter)
app.route('/api/v1', v1Router)

app.all('/api/*', (c) =>
  c.json({ error: { code: 'NOT_FOUND', message: `No route for ${c.req.method} ${c.req.path}` } }, 404),
)

/* ------------------------------ static SPA ------------------------------ */

const webDist = config.webDist

if (existsSync(path.join(webDist, 'index.html'))) {
  // Gzip text assets on the way out. Hashed bundle + compression is the single
  // biggest first-load win (327 kB of JS ships as ~97 kB).
app.use('/assets/*', async (c, next) => {
    await next()
    if (!c.res.headers.get('content-encoding') && c.res.status === 200) {
      const type = c.res.headers.get('content-type') ?? ''
      if (/javascript|css|svg|json|text/.test(type)) {
        return compress()(c, async () => {})
      }
    }
  })

  // Hashed asset filenames are safe to cache forever.
  app.use(
    '/assets/*',
    serveStatic({
      root: webDist,
      onFound: (_p, c) => {
        c.header('cache-control', 'public, max-age=31536000, immutable')
      },
    }),
  )

  app.use('*', async (c, next) => {
    await next()
    if (c.req.path.startsWith('/assets/')) return
    if (c.res.status === 200 && (c.req.path === '/' || !path.extname(c.req.path))) {
      c.header('cache-control', 'no-cache')
    }
  })

  app.get('*', serveStatic({ root: webDist }))
  // SPA fallback for client-side routes (/drive, /accounts, /p/:token, …)
  app.get('*', serveStatic({ root: webDist, path: 'index.html' }))
} else {
  app.get('*', (c) =>
    c.html(
      `<!doctype html><html><body style="font-family:system-ui;padding:3rem;max-width:640px;margin:auto;line-height:1.6">
        <h1>PSDrive API is running</h1>
        <p>The web app has not been built yet. Run <code>npm run build</code>, then restart, or use
        <code>npm run dev:web</code> for the Vite dev server on port 5173.</p>
        <p><a href="/healthz">/healthz</a></p>
      </body></html>`,
      200,
    ),
  )
}

/* ----------------------------- error handling ---------------------------- */

app.onError((err, c) => {
  const requestId = c.get('requestId')

  if (err instanceof HttpError) {
    return c.json(
      { error: { code: err.code, message: err.message, details: err.details, requestId } },
      err.status as 400,
    )
  }

  if (err instanceof ZodError) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: err.issues[0]?.message ?? 'Invalid request.',
          details: err.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
          requestId,
        },
      },
      400,
    )
  }

  if (err instanceof HTTPException) {
    return c.json({ error: { code: 'HTTP_ERROR', message: err.message, requestId } }, err.status)
  }

  // Client aborted mid-upload: not an application error.
  if ((err as Error).name === 'AbortError') {
    log.debug('request aborted by client', { path: c.req.path })
    return new Response(null, { status: 499 })
  }

  log.error('unhandled error', {
    path: `${c.req.method} ${c.req.path}`,
    error: (err as Error).message,
    requestId,
  })
  console.error(err)

  return c.json(
    {
      error: {
        code: 'INTERNAL_ERROR',
        message: config.demoMode ? (err as Error).message : 'Something went wrong on our side.',
        requestId,
      },
    },
    500,
  )
})

app.notFound((c) => c.json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, 404))
