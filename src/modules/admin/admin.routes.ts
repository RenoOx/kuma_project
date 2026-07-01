import { env } from '@/config/env.js'
import { db } from '@/db/client.js'
import { businesses, knowledgeBase } from '@/db/schema/index.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import * as businessService from '@/modules/business/business.service.js'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'
import { asc, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import type { Context, Next } from 'hono'

// ── Auth middleware ───────────────────────────────────────────────────────────

async function requireAdmin(c: Context, next: Next): Promise<Response | void> {
  if (!env.ADMIN_SECRET) {
    return c.json({ error: 'not_configured', message: 'ADMIN_SECRET not set on this server' }, 501)
  }
  if (c.req.header('X-Admin-Secret') !== env.ADMIN_SECRET) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
}

// ── Request body schemas ──────────────────────────────────────────────────────

const createBusinessBody = z
  .object({
    name: z.string().min(1),
    whatsappNumber: z.string().min(1),
    ownerWhatsappNumber: z.string().min(1).nullable().optional(),
    ownerName: z.string().min(1).nullable().optional(),
    timezone: z.string().optional(),
  })
  .refine(
    (v) => !v.ownerWhatsappNumber || v.ownerWhatsappNumber !== v.whatsappNumber,
    {
      message:
        'ownerWhatsappNumber must be different from whatsappNumber — the bot is logged in as whatsappNumber so messages from that same number are treated as fromMe and never reach the owner assistant. Use a separate personal number for the owner.',
      path: ['ownerWhatsappNumber'],
    },
  )

const patchBusinessBody = z
  .object({
    name: z.string().min(1).optional(),
    whatsappNumber: z.string().min(1).optional(),
    ownerWhatsappNumber: z.string().min(1).nullable().optional(),
    ownerName: z.string().min(1).nullable().optional(),
    timezone: z.string().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'body must have at least one field' })
  .refine(
    (v) => !v.ownerWhatsappNumber || !v.whatsappNumber || v.ownerWhatsappNumber !== v.whatsappNumber,
    {
      message:
        'ownerWhatsappNumber must be different from whatsappNumber — the bot is logged in as whatsappNumber so messages from that same number are treated as fromMe and never reach the owner assistant.',
      path: ['ownerWhatsappNumber'],
    },
  )

const createKbBody = z.object({
  category: z.string().min(1),
  content: z.string().min(1),
})

const patchKbBody = z
  .object({
    category: z.string().min(1).optional(),
    content: z.string().min(1).optional(),
  })
  .refine((v) => v.category !== undefined || v.content !== undefined, {
    message: 'body must have at least one of: category, content',
  })

// ── Helper ────────────────────────────────────────────────────────────────────

function appErrorStatus(code: string): 400 | 404 | 409 | 422 | 500 {
  const map: Record<string, 400 | 404 | 409 | 422 | 500> = {
    not_found: 404,
    conflict: 409,
    validation_error: 400,
    not_configured: 422,
    slot_too_soon: 400,
  }
  return map[code] ?? 500
}

// ── Router ────────────────────────────────────────────────────────────────────

export const adminRoutes = new Hono()

adminRoutes.use('/admin/*', requireAdmin)

// ── Businesses ────────────────────────────────────────────────────────────────

adminRoutes.get('/admin/businesses', async (c) => {
  const rows = await db
    .select()
    .from(businesses)
    .orderBy(asc(businesses.createdAt))
  return c.json({ items: rows })
})

adminRoutes.post('/admin/businesses', async (c) => {
  const body = createBusinessBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json({ error: 'validation_error', issues: body.error.flatten().fieldErrors }, 400)
  }
  const result = await businessService.register(body.data)
  if (!result.ok) {
    return c.json({ error: result.error.code, message: result.error.message }, appErrorStatus(result.error.code))
  }
  return c.json(result.data, 201)
})

adminRoutes.get('/admin/businesses/:id', async (c) => {
  const result = await businessService.getById(c.req.param('id'))
  if (!result.ok) {
    return c.json({ error: result.error.code, message: result.error.message }, appErrorStatus(result.error.code))
  }
  return c.json(result.data)
})

adminRoutes.patch('/admin/businesses/:id', async (c) => {
  const body = patchBusinessBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json({ error: 'validation_error', issues: body.error.flatten().fieldErrors }, 400)
  }
  try {
    const updated = await businessRepo.update(c.req.param('id'), body.data)
    return c.json(updated)
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown error'
    const status = msg.includes('not found') ? 404 : 500
    return c.json({ error: 'update_failed', message: msg }, status)
  }
})

// ── Settings ──────────────────────────────────────────────────────────────────

adminRoutes.get('/admin/businesses/:id/settings', async (c) => {
  const result = await businessService.getSettings(c.req.param('id'))
  if (!result.ok) {
    return c.json(
      { error: result.error.code, message: result.error.message },
      appErrorStatus(result.error.code),
    )
  }
  return c.json(result.data)
})

// PUT = full replacement (not merge). Body must be a complete BusinessSettings object.
adminRoutes.put('/admin/businesses/:id/settings', async (c) => {
  const raw = await c.req.json().catch(() => null)
  const parsed = businessSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    return c.json(
      { error: 'validation_error', issues: parsed.error.flatten().fieldErrors },
      400,
    )
  }
  try {
    const updated = await businessRepo.update(c.req.param('id'), {
      settings: parsed.data as Record<string, unknown>,
    })
    return c.json(updated.settings)
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown error'
    const status = msg.includes('not found') ? 404 : 500
    return c.json({ error: 'update_failed', message: msg }, status)
  }
})

// ── Knowledge base ────────────────────────────────────────────────────────────

adminRoutes.get('/admin/businesses/:id/kb', async (c) => {
  const rows = await db
    .select()
    .from(knowledgeBase)
    .where(eq(knowledgeBase.businessId, c.req.param('id')))
    .orderBy(asc(knowledgeBase.category), asc(knowledgeBase.createdAt))
  return c.json({ items: rows })
})

adminRoutes.post('/admin/businesses/:id/kb', async (c) => {
  const body = createKbBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json({ error: 'validation_error', issues: body.error.flatten().fieldErrors }, 400)
  }
  const [row] = await db
    .insert(knowledgeBase)
    .values({ id: nanoid(), businessId: c.req.param('id'), ...body.data })
    .returning()
  return c.json(row, 201)
})

adminRoutes.patch('/admin/kb/:id', async (c) => {
  const body = patchKbBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json({ error: 'validation_error', issues: body.error.flatten().fieldErrors }, 400)
  }
  const rows = await db
    .update(knowledgeBase)
    .set({ ...body.data, updatedAt: new Date() })
    .where(eq(knowledgeBase.id, c.req.param('id')))
    .returning()
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404)
  return c.json(rows[0])
})

adminRoutes.delete('/admin/kb/:id', async (c) => {
  const rows = await db
    .delete(knowledgeBase)
    .where(eq(knowledgeBase.id, c.req.param('id')))
    .returning({ id: knowledgeBase.id })
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404)
  return c.json({ deleted: rows[0]?.id })
})
