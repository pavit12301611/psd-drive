import { Hono } from 'hono'
import { z } from 'zod'
import { config } from '../config.ts'
import { get } from '../db/index.ts'
import { requireUser } from '../middleware/auth.ts'
import { listActivity } from '../services/activity.ts'
import { toPublicAccount, usageByAccount, listAccounts } from '../services/accounts.ts'
import { poolSummary, refreshAllQuotas, revalidateQuotas } from '../services/quota.ts'
import { getPolicy } from '../services/routing.ts'
import { googleOAuth, readSetting, saveGoogleOAuth } from '../services/settings.ts'

/* ------------------------------- dashboard ------------------------------- */

export const statsRouter = new Hono()
statsRouter.use('*', requireUser)

statsRouter.get('/', (c) => {
  const user = c.get('user')
  // Kick off background quota refreshes; never await them on the hot path.
  revalidateQuotas(user.id)

  const usage = usageByAccount(user.id)
  const counts = get<{ files: number; folders: number; shares: number; trash: number; bytes: number }>(
    `select
       (select count(*) from files where user_id = ? and status = 'active') as files,
       (select count(*) from folders where user_id = ? and deleted_at is null) as folders,
       (select count(*) from shares where user_id = ? and enabled = 1) as shares,
       (select count(*) from files where user_id = ? and status = 'trashed') as trash,
       (select coalesce(sum(size_bytes), 0) from files where user_id = ? and status = 'active') as bytes`,
    user.id,
    user.id,
    user.id,
    user.id,
    user.id,
  )!

  return c.json({
    pool: poolSummary(user.id),
    accounts: listAccounts(user.id).map((a) => toPublicAccount(a, usage.get(a.id) ?? 0)),
    counts: {
      files: Number(counts.files),
      folders: Number(counts.folders),
      shares: Number(counts.shares),
      trash: Number(counts.trash),
      bytes: Number(counts.bytes),
    },
    policy: getPolicy(user.id),
    activity: listActivity(user.id, 8),
    googleConfigured: Boolean(googleOAuth()),
    demoMode: config.demoMode,
    maxUploadBytes: config.maxUploadBytes,
  })
})

statsRouter.post('/refresh', async (c) => {
  const user = c.get('user')
  await refreshAllQuotas(user.id)
  return c.json({ pool: poolSummary(user.id), ok: true })
})

/* -------------------------------- activity ------------------------------- */

export const activityRouter = new Hono()
activityRouter.use('*', requireUser)

activityRouter.get('/', (c) => {
  const user = c.get('user')
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200)
  const before = c.req.query('before') ? Number(c.req.query('before')) : undefined
  const items = listActivity(user.id, limit, before)
  return c.json({ activity: items, nextBefore: items.length === limit ? items[items.length - 1].createdAt : null })
})

/* -------------------------------- settings ------------------------------- */

export const settingsRouter = new Hono()
settingsRouter.use('*', requireUser)

settingsRouter.get('/', (c) => {
  const user = c.get('user')
  const oauth = googleOAuth()
  const stored = readSetting<{ clientId?: string; redirectUri?: string } | null>('google_oauth', null)

  return c.json({
    user: c.get('user'),
    google: {
      configured: Boolean(oauth),
      clientId: stored?.clientId || config.google.clientId || null,
      redirectUri: oauth?.redirectUri ?? `${config.appUrl}/api/oauth/google/callback`,
      usingEnv: Boolean(config.google.clientId),
    },
    instance: {
      appUrl: config.appUrl,
      demoMode: config.demoMode,
      maxUploadBytes: config.maxUploadBytes,
      version: '2.0.0',
    },
    storage: {
      accounts: listAccounts(user.id).length,
      dataDir: 'local',
    },
  })
})

settingsRouter.put('/google', async (c) => {
  const body = z
    .object({
      clientId: z.string().trim().min(10).max(300),
      clientSecret: z.string().trim().max(400).optional(),
      redirectUri: z.string().trim().url().optional(),
    })
    .parse(await c.req.json())

  saveGoogleOAuth(body)
  return c.json({ ok: true, configured: Boolean(googleOAuth()) })
})

settingsRouter.delete('/google', (c) => {
  readSetting('google_oauth', null)
  return c.json({ ok: true })
})
