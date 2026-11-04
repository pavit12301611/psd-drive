import { config } from '../config.ts'

type Level = 'debug' | 'info' | 'warn' | 'error'

const weights: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = weights[config.logLevel] ?? 20

const colors: Record<Level, string> = {
  debug: '\x1b[90m',
  info: '\x1b[36m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (weights[level] < threshold) return
  const time = new Date().toISOString().slice(11, 23)
  const tag = `${colors[level]}${level.toUpperCase().padEnd(5)}\x1b[0m`
  const extras = meta && Object.keys(meta).length ? ' ' + formatMeta(meta) : ''
  const line = `\x1b[90m${time}\x1b[0m ${tag} ${msg}${extras}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

function formatMeta(meta: Record<string, unknown>): string {
  return Object.entries(meta)
    .map(([k, v]) => {
      if (typeof v === 'number') return `${k}=${v >= 1000 ? v.toFixed(1) + 'ms' : v}`
      if (typeof v === 'string') return `${k}=${v}`
      return `${k}=${JSON.stringify(v)}`
    })
    .join(' ')
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
}
