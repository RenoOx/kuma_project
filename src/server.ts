import { serve } from '@hono/node-server'
import { app } from './app.js'
import { env } from './config/env.js'
import { logger } from './config/logger.js'

const server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    logger.info({ port: info.port, env: env.NODE_ENV }, 'kuma server listening')
  },
)

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'received shutdown signal')
  server.close(() => {
    logger.info('server closed')
    process.exit(0)
  })
  setTimeout(() => {
    logger.error('forced shutdown after timeout')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception')
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandled rejection')
  process.exit(1)
})
