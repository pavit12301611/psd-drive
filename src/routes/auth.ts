import { Hono } from 'hono'
import { deleteCookie, getCookie } from 'hono/cookie'
import { z } from 'zod'
import { config } from '../config.ts'
import { get, run } from '../db/index.ts'
import { hashPassword, newId, randomToken, sha256, verifyPassword } from '../lib/crypto.ts'
import { HttpError, conflict, unauthorized } from '../lib/errors.ts'
import { rateLimit } from '../lib/ratelimit.ts'
import { logActivity } from '../services/activity.ts'
import { loadUser, requireUser } from '../middleware/auth.ts'
import { ACCESS_COOKIE, REFRESH_COOKIE, issueSession, publicUser } from '../services/session.ts'
import { ensureDemoUser } from '../services/demo.ts'
import { googleOAuth } from '../services/settings.ts'

export const authRouter = new Hono()

const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(8, 'Password must be at least 8 characters.').max(200),
})

const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(1, 'Tell us your name.').max(80),
})

/**
 * Public instance facts the login and setup screens need *before* there is a
 * session: is this a brand-new install, is Google configured, is demo mode on.
 */
authRouter.get('/instance', (c) => {
  const users = Number(get<{ c: number }>('select count(*) as c from users')?.c ?? 0)
  const oauth = googleOAuth()
  return c.json({
    needsSetup: users === 0,
    users,
    signupOpen: users === 0 || config.allowSignup,
    demoMode: config.demoMode,
    localDiskEnabled: config.localDisk,
    google: {
      configured: Boolean(oauth),
      redirectUri: oauth?.redirectUri ?? `${config.appUrl}/api/oauth/google/callback`,
      clientId: config.google.clientId || null,
    },
    appUrl: config.appUrl,
    version: '2.0.0',
  })
})

authRouter.post('/register', async (c) => {
  const body = registerSchema.parse(await c.req.json())
  rateLimit(`register:${c.req.header('x-forwarded-for') ?? 'local'}`, 10, 60_000)

  const existing = get<{ id: string }>('select id from users where email = ?', body.email)
  if (existing) throw conflict('An account with that email already exists.')

  // The very first user always gets in (they are the owner); after that the
  // instance owner decides whether strangers may self-register.
  const userCount = Number(get<{ c: number }>('select count(*) as c from users')?.c ?? 0)
  if (userCount > 0 && !config.allowSignup) {
    throw new HttpError(403, 'SIGNUP_CLOSED', 'This instance is not accepting new sign-ups.')
  }

  const now = Date.now()
  const id = newId()
  run(
    `insert into users (id, name, email, password_hash, role, status, created_at, updated_at)
     values (?, ?, ?, ?, 'owner', 'active', ?, ?)`,
    id,
    body.name,
    body.email,
    hashPassword(body.password),
    now,
    now,
  )

  logActivity({ userId: id, action: 'account.created', entityType: 'user', entityId: id, entityName: body.name })
  const session = issueSession(c, { id, email: body.email, name: body.name })
  return c.json({ ...session, user: publicUser(loadUser(id)!) }, 201)
})

authRouter.post('/login', async (c) => {
  const body = credentialsSchema.parse(await c.req.json())
  const ip = c.req.header('x-forwarded-for') ?? 'local'
  rateLimit(`login:${ip}:${body.email}`, 8, 60_000)

  const row = get<{ id: string; name: string; email: string; password_hash: string; status: string }>(
    'select id, name, email, password_hash, status from users where email = ?',
    body.email,
  )

  // Constant-ish time: always run a hash comparison.
  const valid = row ? verifyPassword(body.password, row.password_hash) : verifyPassword(body.password, hashPassword('decoy'))
  if (!row || !valid || row.status !== 'active') throw unauthorized('Email or password is incorrect.')

  const session = issueSession(c, { id: row.id, email: row.email, name: row.name })
  return c.json({ ...session, user: publicUser(loadUser(row.id)!) })
})

/** Exchange the refresh cookie for a fresh access token. */
authRouter.post('/refresh', async (c) => {
  const token = getCookie(c, REFRESH_COOKIE)
  if (!token) throw unauthorized('No session found.')

  const session = get<{ id: string; user_id: string; expires_at: number; revoked_at: number | null }>(
    'select id, user_id, expires_at, revoked_at from sessions where token_hash = ?',
    sha256(token),
  )

  if (!session || session.revoked_at || session.expires_at < Date.now()) {
    deleteCookie(c, REFRESH_COOKIE, { path: '/api/auth' })
    throw unauthorized('Your session expired. Please sign in again.')
  }

  const user = loadUser(session.user_id)
  if (!user) throw unauthorized('This account is no longer active.')

  // Rotate: the old refresh token is burned on every use.
  const next = issueSession(c, user, { rotateFrom: token })
  return c.json({ ...next, user: publicUser(user) })
})

authRouter.post('/logout', async (c) => {
  const token = getCookie(c, REFRESH_COOKIE)
  if (token) {
    run('update sessions set revoked_at = ? where token_hash = ?', Date.now(), sha256(token))
    deleteCookie(c, REFRESH_COOKIE, { path: '/api/auth' })
  }
  deleteCookie(c, ACCESS_COOKIE, { path: '/' })
  return c.json({ ok: true })
})

authRouter.get('/me', requireUser, (c) => c.json({ user: publicUser(c.get('user')) }))

/** One-click demo: only available when DEMO_MODE is on. */
authRouter.post('/demo', async (c) => {
  if (!config.demoMode) throw unauthorized('Demo mode is disabled on this instance.')
  rateLimit(`demo:${c.req.header('x-forwarded-for') ?? 'local'}`, 20, 60_000)

  const demo = await ensureDemoUser()
  const session = issueSession(c, demo)
  return c.json({ ...session, user: publicUser(loadUser(demo.id)!) })
})
