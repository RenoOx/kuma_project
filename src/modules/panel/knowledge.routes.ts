import type { Context } from 'hono'
import { Hono } from 'hono'
import type { z } from 'zod'
import * as knowledgeBaseService from '@/modules/knowledgeBase/knowledgeBase.service.js'
import {
  createKbBodySchema,
  patchKbBodySchema,
} from '@/modules/knowledgeBase/knowledgeBase.types.js'
import type { AppError } from '@/shared/errors.js'
import { NotFoundError, ValidationError } from '@/shared/errors.js'
import type { Result } from '@/shared/result.js'
import { panelAuth, panelBusiness } from './panelAuth.js'
import { panelWriteLock } from './panelLocks.js'

export const panelKnowledgeRoutes = new Hono()

// Auth on the whole surface, same wildcard as the other panel route files.
panelKnowledgeRoutes.use('/api/panel/:businessId/*', panelAuth)
// La base de conocimiento es de solo lectura para el dueño (ver panelLocks).
panelKnowledgeRoutes.use('/api/panel/:businessId/*', panelWriteLock)

function failure(c: Context, error: AppError): Response {
  const status = error instanceof NotFoundError ? 404 : error instanceof ValidationError ? 400 : 500
  return c.json({ error: error.code, message: error.userMessage }, status) as Response
}

function respond<T>(c: Context, result: Result<T>): Response {
  if (!result.ok) return failure(c, result.error)
  return c.json(result.data) as Response
}

async function parseBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; res: Response }> {
  const raw = await c.req.json().catch(() => null)
  const parsed = schema.safeParse(raw)
  if (parsed.success) return { ok: true, data: parsed.data }
  return {
    ok: false,
    res: c.json(
      { error: 'invalid_body', message: 'Datos inválidos.', details: parsed.error.issues },
      400,
    ) as Response,
  }
}

/**
 * The knowledge base, from the owner's side.
 *
 * Thin on purpose: knowledgeBaseService already returns Result and every repo
 * query it calls filters on `and(id, businessId)`, so the tenant check is not
 * re-implemented here — it is passed down from `panelBusiness(c).id`, which the
 * auth middleware resolved from the path. No handler reads an id from a body.
 *
 * The request schemas come from knowledgeBase.types.ts, shared with the admin
 * API: both write the same table under the same attachment and keyword rules.
 */

panelKnowledgeRoutes.get('/api/panel/:businessId/knowledge', async (c) => {
  // Returns inactive entries too. The panel shows them greyed out rather than
  // hiding them — an entry the owner switched off is one they may switch back
  // on, and a list that silently omits it looks like it was deleted.
  return respond(c, await knowledgeBaseService.getByBusiness(panelBusiness(c).id))
})

panelKnowledgeRoutes.post('/api/panel/:businessId/knowledge', async (c) => {
  const body = await parseBody(c, createKbBodySchema)
  if (!body.ok) return body.res

  const result = await knowledgeBaseService.create({
    businessId: panelBusiness(c).id,
    ...body.data,
  })
  if (!result.ok) return failure(c, result.error)
  return c.json(result.data, 201)
})

panelKnowledgeRoutes.patch('/api/panel/:businessId/knowledge/:id', async (c) => {
  const body = await parseBody(c, patchKbBodySchema)
  if (!body.ok) return body.res

  return respond(
    c,
    await knowledgeBaseService.update(panelBusiness(c).id, c.req.param('id'), body.data),
  )
})

panelKnowledgeRoutes.delete('/api/panel/:businessId/knowledge/:id', async (c) => {
  const result = await knowledgeBaseService.remove(panelBusiness(c).id, c.req.param('id'))
  if (!result.ok) return failure(c, result.error)
  return c.json({ deleted: result.data })
})
