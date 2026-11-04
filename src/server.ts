import { serve } from '@hono/node-server'
import { app } from './app.ts'
import { config } from './config.ts'
import { migrate, dbInfo } from './db/schema.ts'
import { closeDb } from './db/index.ts'
import { log } from './lib/logger.ts'
import { ensureDemoUser } from './services/demo.ts'

async function main() {
  const started = performance.now()

  migrate()

  if (config.demoMode) {
    // Idempotent: creates the demo workspace the first time only.
    await ensureDemoUser()
  }

  const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
    const ms = Math.round(performance.now() - started)
    const info2 = dbInfo()
    log.info('PSDrive is ready', {
      url: `http://localhost:${info.port}`,
      boot: ms,
      sqlite: info2.version,
      users: info2.users,
    })
    if (info2.users === 0) {
      log.info(`first run — open http://localhost:${info.port} to create your account and connect Google Drive`)
    }
    if (config.demoMode) log.info('demo mode is ON — a sample workspace is available from the login screen')
    if (config.google.clientId) log.info('Google OAuth credentials loaded from the environment')
  })

  const shutdown = (signal: string) => {
    log.info(`received ${signal}, shutting down`)
    server.close(() => {
      closeDb()
      process.exit(0)
    })
    setTimeout(() => process.exit(0), 5000).unref()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { reason: String(reason) }))
}

main().catch((err) => {
  log.error('failed to start', { error: (err as Error).message })
  console.error(err)
  process.exit(1)
})
