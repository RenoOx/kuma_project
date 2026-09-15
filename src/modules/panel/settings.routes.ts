import type { Context } from 'hono'
import { Hono } from 'hono'
import type { z } from 'zod'
import type { AppError } from '@/shared/errors.js'
import { NotFoundError, ValidationError } from '@/shared/errors.js'
import type { Result } from '@/shared/result.js'
import { panelAuth, panelBusiness } from './panelAuth.js'
import * as settingsService from './settings.service.js'

export const panelSettingsRoutes = new Hono()

// Same wildcard guard as panel.routes: registered on the whole surface so a
// handler added below cannot forget it. The business this resolves is the ONLY
// source of the tenant id in this file — nothing here reads an id from a body.
panelSettingsRoutes.use('/api/panel/:businessId/*', panelAuth)

function failure(c: Context, error: AppError): Response {
  const status = error instanceof NotFoundError ? 404 : error instanceof ValidationError ? 400 : 500
  return c.json({ error: error.code, message: error.userMessage }, status) as Response
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

function respond<T>(c: Context, result: Result<T>): Response {
  if (!result.ok) return failure(c, result.error)
  return c.json(result.data) as Response
}

// ── Read ─────────────────────────────────────────────────────────────────────

panelSettingsRoutes.get('/api/panel/:businessId/settings', (c) => {
  return c.json(settingsService.readSettings(panelBusiness(c)))
})

// ── Sections ─────────────────────────────────────────────────────────────────
//
// Four PATCHes rather than one PUT. The panel's forms each load and own one
// section, and a PUT would let a form that never loaded `services` erase it by
// omission. Each handler merges its section into the stored document and
// revalidates the whole thing — see mergeSettingsSection.

panelSettingsRoutes.patch('/api/panel/:businessId/settings/general', async (c) => {
  const body = await parseBody(c, settingsService.generalPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateGeneral(panelBusiness(c).id, body.data))
})

panelSettingsRoutes.patch('/api/panel/:businessId/settings/schedule', async (c) => {
  const body = await parseBody(c, settingsService.schedulePatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateSchedule(panelBusiness(c).id, body.data))
})

panelSettingsRoutes.patch('/api/panel/:businessId/settings/special-days', async (c) => {
  const body = await parseBody(c, settingsService.specialDaysPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateSpecialDays(panelBusiness(c).id, body.data))
})

panelSettingsRoutes.patch('/api/panel/:businessId/settings/booking', async (c) => {
  const body = await parseBody(c, settingsService.bookingPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateBooking(panelBusiness(c).id, body.data))
})

panelSettingsRoutes.patch('/api/panel/:businessId/settings/services', async (c) => {
  const body = await parseBody(c, settingsService.servicesPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateServices(panelBusiness(c).id, body.data))
})

panelSettingsRoutes.patch('/api/panel/:businessId/settings/payments', async (c) => {
  const body = await parseBody(c, settingsService.paymentsPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updatePayments(panelBusiness(c).id, body.data))
})

panelSettingsRoutes.patch('/api/panel/:businessId/settings/bot', async (c) => {
  const body = await parseBody(c, settingsService.botPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateBotPaused(panelBusiness(c).id, body.data))
})

// ── Integrations ─────────────────────────────────────────────────────────────
//
// Read-only, and with no write counterpart by design. Pairing or dropping a
// WhatsApp session is not reachable from the panel: the credential here is a
// token in a URL, and a mis-click behind it would take the business's own
// number off WhatsApp. Those actions stay in the admin surface.

panelSettingsRoutes.get('/api/panel/:businessId/integrations', async (c) => {
  return c.json(await settingsService.readIntegrations(panelBusiness(c)))
})
