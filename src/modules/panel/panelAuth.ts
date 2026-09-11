import type { Context, MiddlewareHandler } from 'hono'
import { logger } from '@/config/logger.js'
import type { Business } from '@/db/schema/index.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import { panelTokenMatches } from './panelToken.js'

// Typed context slot, so downstream handlers read the business off the context
// without casting. Hono resolves this through module augmentation.
declare module 'hono' {
  interface ContextVariableMap {
    panelBusiness: Business
  }
}

const UNAUTHORIZED = { error: 'unauthorized' } as const

/**
 * Auth for every /api/panel/:businessId/* route.
 *
 * Stateless by design (US-01 AC3): no cookies, no JWT, no session table. The
 * token in the query string IS the credential, which is what makes the panel
 * usable by a shop owner who will never manage a password.
 *
 * Every failure answers the same 401 with the same body. Distinguishing "no
 * such business" from "wrong token" would turn this endpoint into a probe for
 * which business ids exist — the same reason /health reports WhatsApp as an
 * aggregate.
 */
export const panelAuth: MiddlewareHandler = async (c, next) => {
  const businessId = c.req.param('businessId')
  const token = c.req.query('token')

  if (!businessId || !token) return c.json(UNAUTHORIZED, 401)

  const business = await businessRepo.findById(businessId)
  if (!business || !panelTokenMatches(business.panelToken, token)) {
    // No token material in the log line, not even a prefix: these end up in
    // Railway's log drain, and the token is the whole credential.
    logger.warn({ businessId, path: c.req.path }, 'panel auth rejected')
    return c.json(UNAUTHORIZED, 401)
  }

  c.set('panelBusiness', business)
  await next()
  return
}

/** Reads the business the middleware resolved. Only valid behind `panelAuth`. */
export function panelBusiness(c: Context): Business {
  return c.get('panelBusiness')
}
