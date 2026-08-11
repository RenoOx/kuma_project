import { env } from '@/config/env.js'
import { logger } from '@/config/logger.js'
import { db } from '@/db/client.js'
import { businesses, type KbAttachmentType } from '@/db/schema/index.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import * as businessService from '@/modules/business/business.service.js'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'
import * as knowledgeBaseService from '@/modules/knowledgeBase/knowledgeBase.service.js'
import {
  kbAttachmentTypeSchema,
  kbCategorySchema,
  kbSendModeSchema,
} from '@/modules/knowledgeBase/knowledgeBase.types.js'
import * as sessionGuard from '@/modules/whatsapp/sessionGuard.service.js'
import { SessionGuardError } from '@/shared/errors.js'
import { asc } from 'drizzle-orm'
import { Hono } from 'hono'
import { rm } from 'node:fs/promises'
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
    address: z.string().min(1).nullable().optional(),
    googleMapsUrl: z.string().url().nullable().optional(),
  })
  .refine(
    (v) => !v.ownerWhatsappNumber || v.ownerWhatsappNumber !== v.whatsappNumber,
    {
      message:
        'ownerWhatsappNumber must be different from whatsappNumber — the bot is logged in as whatsappNumber so messages from that same number are treated as fromMe and never reach the owner assistant. Use a separate personal number for the owner.',
      path: ['ownerWhatsappNumber'],
    },
  )

// Deliberately awkward: forcing past the anti-ban guard should require typing
// the consequence out, not a reflexive `-d '{}'`.
const forceUnblockBody = z.object({
  confirm: z.literal('I understand this can get the number banned'),
})

const patchBusinessBody = z
  .object({
    name: z.string().min(1).optional(),
    whatsappNumber: z.string().min(1).optional(),
    ownerWhatsappNumber: z.string().min(1).nullable().optional(),
    ownerName: z.string().min(1).nullable().optional(),
    timezone: z.string().optional(),
    address: z.string().min(1).nullable().optional(),
    googleMapsUrl: z.string().url().nullable().optional(),
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

// An attachment type other than 'none' is meaningless without a URL, and a URL
// is meaningless without a type. Rejected up front rather than stored half-set.
function hasCoherentAttachment(v: {
  attachmentType?: KbAttachmentType
  attachmentUrl?: string | null
}): boolean {
  if (v.attachmentType === undefined) return true
  return v.attachmentType === 'none' ? !v.attachmentUrl : Boolean(v.attachmentUrl)
}

const attachmentRefinement = {
  message:
    'attachmentUrl is required when attachmentType is not "none", and must be omitted when it is',
  path: ['attachmentUrl'],
}

const kbFields = {
  title: z.string().min(1).max(120).optional(),
  content: z.string().min(1),
  category: kbCategorySchema,
  attachmentType: kbAttachmentTypeSchema.optional(),
  attachmentUrl: z.string().url().nullable().optional(),
  sendMode: kbSendModeSchema.optional(),
  triggerKeywords: z.array(z.string().min(1)).nullable().optional(),
  active: z.boolean().optional(),
}

const createKbBody = z
  .object(kbFields)
  .refine(hasCoherentAttachment, attachmentRefinement)
  .refine((v) => v.sendMode !== 'trigger_based' || (v.triggerKeywords?.length ?? 0) > 0, {
    message: 'triggerKeywords is required when sendMode is "trigger_based"',
    path: ['triggerKeywords'],
  })

const patchKbBody = z
  .object({ ...kbFields, content: kbFields.content.optional(), category: kbFields.category.optional() })
  .refine((v) => Object.keys(v).length > 0, { message: 'body must have at least one field' })
  .refine(hasCoherentAttachment, attachmentRefinement)
  .refine((v) => v.sendMode !== 'trigger_based' || (v.triggerKeywords?.length ?? 0) > 0, {
    message: 'triggerKeywords is required when sendMode is "trigger_based"',
    path: ['triggerKeywords'],
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

  const businessId = c.req.param('id')
  const existing = await businessRepo.findById(businessId)
  if (!existing) {
    return c.json({ error: 'update_failed', message: `business ${businessId} not found` }, 404)
  }

  const nextNumber = body.data.whatsappNumber
  const numberChanged = nextNumber !== undefined && nextNumber !== existing.whatsappNumber

  // Guard the invariant against the stored value too — a PATCH that only sets
  // ownerWhatsappNumber can still collide with the existing bot number.
  const effectiveOwner = body.data.ownerWhatsappNumber ?? existing.ownerWhatsappNumber
  const effectiveBot = nextNumber ?? existing.whatsappNumber
  if (effectiveOwner && effectiveOwner === effectiveBot) {
    return c.json(
      {
        error: 'validation_error',
        message:
          'ownerWhatsappNumber must be different from whatsappNumber — the bot is logged in as whatsappNumber so messages from that same number are treated as fromMe and never reach the owner assistant.',
      },
      400,
    )
  }

  let updated: Awaited<ReturnType<typeof businessRepo.update>>
  try {
    updated = await businessRepo.update(businessId, body.data)
  } catch (err) {
    const msg = (err as Error).message ?? 'unknown error'
    const status = msg.includes('not found') ? 404 : 500
    return c.json({ error: 'update_failed', message: msg }, status)
  }

  if (!numberChanged) {
    return c.json(updated)
  }

  // Changing the number in the DB alone would leave the live socket logged in
  // as the old one — the bot would keep answering on a number the DB no longer
  // knows about. Rebind, and report honestly if the guard blocked it.
  try {
    const { restartWhatsappFor } = await import('@/server.js')
    await restartWhatsappFor(businessId, updated.whatsappNumber)
    return c.json({ ...updated, whatsappRebind: 'pending_scan' })
  } catch (err) {
    if (err instanceof SessionGuardError) {
      return c.json(
        {
          ...updated,
          whatsappRebind: 'blocked',
          rebindError: err.userMessage,
          retryAfterMs: err.retryAfterMs,
        },
        409,
      )
    }
    logger.error({ err, businessId }, 'admin: rebind after number change failed')
    return c.json(
      { ...updated, whatsappRebind: 'failed', rebindError: (err as Error).message },
      500,
    )
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
//
// Every entry route is nested under /businesses/:id so the tenant is part of
// the path and every query filters on it. The previous flat /admin/kb/:kbId
// PATCH and DELETE were removed: an entry id on its own let a caller mutate any
// tenant's row, which violates rule 3 in CLAUDE.md.

adminRoutes.get('/admin/businesses/:id/kb', async (c) => {
  const result = await knowledgeBaseService.getByBusiness(c.req.param('id'))
  if (!result.ok) {
    return c.json({ error: result.error.code, message: result.error.message }, 500)
  }
  return c.json({ items: result.data })
})

adminRoutes.post('/admin/businesses/:id/kb', async (c) => {
  const body = createKbBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json({ error: 'validation_error', issues: body.error.flatten().fieldErrors }, 400)
  }
  const businessId = c.req.param('id')
  const business = await businessRepo.findById(businessId)
  if (!business) return c.json({ error: 'not_found' }, 404)

  const result = await knowledgeBaseService.create({ businessId, ...body.data })
  if (!result.ok) {
    return c.json({ error: result.error.code, message: result.error.message }, 500)
  }
  return c.json(result.data, 201)
})

adminRoutes.patch('/admin/businesses/:id/kb/:kbId', async (c) => {
  const body = patchKbBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json({ error: 'validation_error', issues: body.error.flatten().fieldErrors }, 400)
  }
  const result = await knowledgeBaseService.update(
    c.req.param('id'),
    c.req.param('kbId'),
    body.data,
  )
  if (!result.ok) {
    return c.json(
      { error: result.error.code, message: result.error.message },
      appErrorStatus(result.error.code),
    )
  }
  return c.json(result.data)
})

adminRoutes.delete('/admin/businesses/:id/kb/:kbId', async (c) => {
  const result = await knowledgeBaseService.remove(c.req.param('id'), c.req.param('kbId'))
  if (!result.ok) {
    return c.json(
      { error: result.error.code, message: result.error.message },
      appErrorStatus(result.error.code),
    )
  }
  return c.json({ deleted: result.data })
})

// ── WhatsApp session ──────────────────────────────────────────────────────────

adminRoutes.delete('/admin/businesses/:id/session', async (c) => {
  const business = await businessRepo.findById(c.req.param('id'))
  if (!business) return c.json({ error: 'not_found' }, 404)

  const sessionDir = `${env.SESSIONS_DIR}/${business.id}`
  try {
    await rm(sessionDir, { recursive: true, force: true })
    return c.json({
      deleted: sessionDir,
      next: 'Restart the service so Baileys boots a fresh session and generates a new QR / pairing code.',
    })
  } catch (err) {
    return c.json({ error: 'delete_failed', message: (err as Error).message }, 500)
  }
})

// Manual resume for a business whose Baileys client halted after a loggedOut.
// This is the ONLY sanctioned path to retry a pairing — the operator must
// decide it's safe (WA rate-limits generally expire after 24h of no activity).
// Boots a fresh Baileys client without needing a Railway restart.
adminRoutes.post('/admin/businesses/:id/session/resume', async (c) => {
  const business = await businessRepo.findById(c.req.param('id'))
  if (!business) return c.json({ error: 'not_found' }, 404)

  try {
    // Deferred import to avoid a cycle between admin.routes and server.
    const { restartWhatsappFor } = await import('@/server.js')
    await restartWhatsappFor(business.id, business.whatsappNumber)
    return c.json({
      resumed: business.id,
      next: 'Visit /admin/whatsapp/qr to scan the fresh QR.',
    })
  } catch (err) {
    if (err instanceof SessionGuardError) {
      return c.json(
        {
          error: err.code,
          message: err.userMessage,
          retryAfterMs: err.retryAfterMs,
          next: 'Wait out the cool-off. Only force-unblock if you are certain this is a false positive.',
        },
        429,
      )
    }
    return c.json({ error: 'resume_failed', message: (err as Error).message }, 500)
  }
})

// Read-only view of the anti-ban guard for a business's number.
adminRoutes.get('/admin/businesses/:id/session/guard', async (c) => {
  const business = await businessRepo.findById(c.req.param('id'))
  if (!business) return c.json({ error: 'not_found' }, 404)

  const status = await sessionGuard.getStatus(business.whatsappNumber)
  return c.json({ whatsappNumber: business.whatsappNumber, ...status })
})

// Operator escape hatch: clears cooldowns, the attempt window and any halt for
// this business's number. Requires an explicit confirm in the body so it can't
// be triggered by a stray curl or a retried request. Every call is logged loudly
// — forcing past this guard is how the previous production number got burned.
adminRoutes.post('/admin/businesses/:id/session/force-unblock', async (c) => {
  const business = await businessRepo.findById(c.req.param('id'))
  if (!business) return c.json({ error: 'not_found' }, 404)

  const body = forceUnblockBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json(
      {
        error: 'confirmation_required',
        message:
          'Send {"confirm":"I understand this can get the number banned"} to force-unblock. Prefer waiting out the cool-off.',
      },
      400,
    )
  }

  const before = await sessionGuard.getStatus(business.whatsappNumber)
  await sessionGuard.forceUnblock(business.whatsappNumber, business.id)
  logger.warn(
    {
      businessId: business.id,
      whatsappNumber: business.whatsappNumber,
      clearedBlockedUntil: before.blockedUntil,
      clearedHaltReason: before.haltReason,
    },
    'admin: whatsapp session guard force-unblocked via API',
  )

  return c.json({
    unblocked: business.id,
    cleared: before,
    next: 'POST /admin/businesses/:id/session/resume to boot a fresh client, then scan the QR once.',
  })
})
