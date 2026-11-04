import { rateLimited } from './errors.ts'

/**
 * In-process fixed-window limiter. No Redis, no network hop — it costs a Map
 * lookup per request and is enough for a single-node self-hosted app.
 */

type Bucket = { count: number; resetAt: number }
const buckets = new Map<string, Bucket>()

const SWEEP_EVERY = 5 * 60_000
let lastSweep = Date.now()

function sweep(now: number) {
  if (now - lastSweep < SWEEP_EVERY) return
  lastSweep = now
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < now) buckets.delete(key)
  }
}

export function rateLimit(key: string, limit: number, windowMs: number): void {
  const now = Date.now()
  sweep(now)
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return
  }
  bucket.count++
  if (bucket.count > limit) {
    const seconds = Math.ceil((bucket.resetAt - now) / 1000)
    throw rateLimited(`Too many attempts. Try again in ${seconds}s.`)
  }
}

export function resetLimiter(): void {
  buckets.clear()
}
