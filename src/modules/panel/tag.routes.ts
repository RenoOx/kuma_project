import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as panelRepo from '@/modules/panel/panel.repo.js'
import * as tagService from '@/modules/tag/tag.service.js'
import {
  assignTagsSchema,
  createTagSchema,
  updateTagSchema,
} from '@/modules/tag/tag.types.js'
import type { AppError } from '@/shared/errors.js'
import { ConflictError, NotFoundError, ValidationError } from '@/shared/errors.js'
import type { Result } from '@/shared/result.js'
import { panelAuth, panelBusiness } from './panelAuth.js'

export const panelTagRoutes = new Hono()

panelTagRoutes.use('/api/panel/:businessId/*', panelAuth)

function failure(c: Context, error: AppError): Response {
  const status =
    error instanceof NotFoundError
      ? 404
      : error instanceof ConflictError
        ? 409
        : error instanceof ValidationError
          ? 400
          : 500
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

// ── Tags ─────────────────────────────────────────────────────────────────────

panelTagRoutes.get('/api/panel/:businessId/tags', async (c) => {
  return respond(c, await tagService.list(panelBusiness(c).id))
})

panelTagRoutes.post('/api/panel/:businessId/tags', async (c) => {
  const body = await parseBody(c, createTagSchema)
  if (!body.ok) return body.res

  const result = await tagService.create(panelBusiness(c).id, body.data)
  if (!result.ok) return failure(c, result.error)
  return c.json(result.data, 201)
})

panelTagRoutes.patch('/api/panel/:businessId/tags/:id', async (c) => {
  const body = await parseBody(c, updateTagSchema)
  if (!body.ok) return body.res
  return respond(c, await tagService.update(panelBusiness(c).id, c.req.param('id'), body.data))
})

panelTagRoutes.delete('/api/panel/:businessId/tags/:id', async (c) => {
  const result = await tagService.remove(panelBusiness(c).id, c.req.param('id'))
  if (!result.ok) return failure(c, result.error)
  // The assignments go with it through the cascade, so a conversation carrying
  // this label simply stops carrying it.
  return c.json({ deleted: result.data })
})

// ── Assignment ───────────────────────────────────────────────────────────────

// PUT, not POST: the body is the complete set of labels on this conversation,
// so sending it twice leaves the same state. The UI already holds the full set.
panelTagRoutes.put('/api/panel/:businessId/conversations/:conversationId/tags', async (c) => {
  const body = await parseBody(c, assignTagsSchema)
  if (!body.ok) return body.res

  return respond(
    c,
    await tagService.assign(
      panelBusiness(c).id,
      c.req.param('conversationId'),
      body.data.tagIds,
    ),
  )
})

// ── Per-chat Emma switch ─────────────────────────────────────────────────────

const emmaSchema = z.object({ enabled: z.boolean() })

/**
 * Switches Emma on or off for one conversation.
 *
 * Deliberately separate from the takeover endpoints next door. A takeover is
 * temporary and expires on its own after 30 minutes; this is the owner saying
 * "I handle this thread", and nothing clears it but another call here.
 */
panelTagRoutes.patch('/api/panel/:businessId/conversations/:conversationId/emma', async (c) => {
  const body = await parseBody(c, emmaSchema)
  if (!body.ok) return body.res

  const businessId = panelBusiness(c).id
  const conversationId = c.req.param('conversationId')

  // Checked through panelRepo so another business's conversation id answers 404
  // instead of silently updating nothing.
  const conversation = await panelRepo.findConversation(businessId, conversationId)
  if (!conversation) return c.json({ error: 'not_found' }, 404)

  await conversationRepo.setEmmaEnabled(businessId, conversationId, body.data.enabled)
  return c.json({ success: true, enabled: body.data.enabled })
})
