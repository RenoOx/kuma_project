import { Hono } from 'hono'
import { logger } from './config/logger.js'
import { googleAuthRoutes } from './modules/google/auth.routes.js'

const VERSION = '0.1.0'

export const app = new Hono()

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: VERSION,
  })
})

app.route('/', googleAuthRoutes)

app.onError((err, c) => {
  logger.error({ err, path: c.req.path }, 'unhandled error')
  return c.json({ error: 'internal_error' }, 500)
})

app.notFound((c) => {
  return c.json({ error: 'not_found' }, 404)
})
