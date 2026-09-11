import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { logger } from '@/config/logger.js'
import { conversationQualifications } from '@/db/schema/index.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import { getConnectionState } from '@/modules/whatsapp/clientRegistry.js'
import type { AppError } from '@/shared/errors.js'
import { NotFoundError, ValidationError } from '@/shared/errors.js'
import type { Result } from '@/shared/result.js'
import * as panelRepo from './panel.repo.js'
import * as panelService from './panel.service.js'
import { panelAuth, panelBusiness } from './panelAuth.js'

export const panelRoutes = new Hono()

// Auth on the whole surface, in one place. Registering it as a wildcard rather
// than per route means a handler added later cannot forget it.
panelRoutes.use('/api/panel/:businessId/*', panelAuth)

// ── Shared helpers ───────────────────────────────────────────────────────────

const MAX_LIMIT = 100

const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(20),
})

const replySchema = z.object({
  // Long enough for anything a person types into a chat box, bounded so a
  // runaway client cannot push a megabyte through WhatsApp.
  text: z.string().trim().min(1).max(4096),
})

const reasonSchema = z.object({
  reason: z.string().trim().max(500).optional(),
})

/**
 * Maps a domain error onto a status code.
 *
 * `userMessage` is the only error text that crosses the wire — it is the field
 * built to be safe to show — while `logContext` stays server-side. Anything
 * unrecognised is a 500 with no detail.
 */
function failure(c: Context, error: AppError): Response {
  const status = error instanceof NotFoundError ? 404 : error instanceof ValidationError ? 400 : 500
  return c.json({ error: error.code, message: error.userMessage }, status) as Response
}

function unwrap<T>(
  c: Context,
  result: Result<T>,
): { ok: true; data: T } | { ok: false; res: Response } {
  if (result.ok) return { ok: true, data: result.data }
  return { ok: false, res: failure(c, result.error) }
}

/** Parses a query object, answering 400 with the field that failed. */
function parseQuery<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): { ok: true; data: z.infer<T> } | { ok: false; res: Response } {
  const parsed = schema.safeParse(c.req.query())
  if (parsed.success) return { ok: true, data: parsed.data }
  return {
    ok: false,
    res: c.json(
      { error: 'invalid_query', message: 'Parámetros inválidos.', details: parsed.error.issues },
      400,
    ) as Response,
  }
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

// ── Inbox ────────────────────────────────────────────────────────────────────

const updatesSchema = z.object({
  since: z.string().datetime().optional(),
})

// The 5-second poll (US-03 AC1). Deliberately the cheapest query in the file:
// two aggregates over one indexed column, so the expensive list below only runs
// when this says something moved.
panelRoutes.get('/api/panel/:businessId/updates', async (c) => {
  const query = parseQuery(c, updatesSchema)
  if (!query.ok) return query.res

  const since = query.data.since ? new Date(query.data.since) : null
  const marker = await panelRepo.getUpdatesMarker(panelBusiness(c).id, since)
  return c.json(marker)
})

const conversationsSchema = paginationSchema.extend({
  qualification: z.enum(conversationQualifications).optional(),
  search: z.string().trim().max(100).optional(),
  sort: z.literal('recent').default('recent'),
})

panelRoutes.get('/api/panel/:businessId/conversations', async (c) => {
  const query = parseQuery(c, conversationsSchema)
  if (!query.ok) return query.res

  const page = await panelRepo.listConversations(panelBusiness(c).id, {
    ...(query.data.qualification ? { qualification: query.data.qualification } : {}),
    ...(query.data.search ? { search: query.data.search } : {}),
    page: query.data.page,
    limit: query.data.limit,
  })
  return c.json(page)
})

const messagesSchema = paginationSchema.extend({
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(50),
  // Defaults to the newest slice — a chat opens at the bottom. See
  // panelRepo.MessageOrder.
  order: z.enum(['asc', 'desc']).default('desc'),
})

panelRoutes.get('/api/panel/:businessId/conversations/:conversationId/messages', async (c) => {
  const query = parseQuery(c, messagesSchema)
  if (!query.ok) return query.res

  const businessId = panelBusiness(c).id
  const conversationId = c.req.param('conversationId')

  // Checked before reading messages so another business's conversation id
  // answers 404 rather than an empty page, which would confirm it exists.
  const conversation = await panelRepo.findConversation(businessId, conversationId)
  if (!conversation) return c.json({ error: 'not_found' }, 404)

  const page = await panelRepo.listMessages(
    businessId,
    conversationId,
    query.data.page,
    query.data.limit,
    query.data.order,
  )
  return c.json({ ...page, qualification: conversation.qualification })
})

// ── Human takeover ───────────────────────────────────────────────────────────

panelRoutes.post('/api/panel/:businessId/conversations/:conversationId/reply', async (c) => {
  const body = await parseBody(c, replySchema)
  if (!body.ok) return body.res

  const result = await panelService.sendOwnerReply(
    panelBusiness(c).id,
    c.req.param('conversationId'),
    body.data.text,
  )
  const unwrapped = unwrap(c, result)
  if (!unwrapped.ok) return unwrapped.res

  return c.json({ success: true, messageId: unwrapped.data.messageId })
})

panelRoutes.post(
  '/api/panel/:businessId/conversations/:conversationId/return-to-emma',
  async (c) => {
    const result = await panelService.returnToEmma(
      panelBusiness(c).id,
      c.req.param('conversationId'),
    )
    const unwrapped = unwrap(c, result)
    if (!unwrapped.ok) return unwrapped.res

    return c.json({ success: true })
  },
)

/**
 * The owner re-labelling a thread by hand (Feature A).
 *
 * The enum comes from panel.service rather than from the full
 * conversationQualifications tuple: 'appointment' and 'human_takeover' are
 * facts the system records, not opinions a person may assert, so they are not
 * offered here and a request carrying one is a 400.
 */
const qualificationSchema = z.object({
  qualification: z.enum(panelService.MANUALLY_SETTABLE_QUALIFICATIONS),
})

panelRoutes.patch(
  '/api/panel/:businessId/conversations/:conversationId/qualification',
  async (c) => {
    const body = await parseBody(c, qualificationSchema)
    if (!body.ok) return body.res

    const result = await panelService.setQualificationByOwner(
      panelBusiness(c).id,
      c.req.param('conversationId'),
      body.data.qualification,
    )
    const unwrapped = unwrap(c, result)
    if (!unwrapped.ok) return unwrapped.res

    return c.json({ success: true, qualification: body.data.qualification })
  },
)

// ── Appointments ─────────────────────────────────────────────────────────────

const rangeSchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
})

panelRoutes.get('/api/panel/:businessId/appointments', async (c) => {
  const query = parseQuery(c, rangeSchema)
  if (!query.ok) return query.res

  const businessId = panelBusiness(c).id
  const [data, pendingCount] = await Promise.all([
    panelRepo.listAppointments(businessId, new Date(query.data.from), new Date(query.data.to)),
    panelRepo.countPendingAppointments(businessId),
  ])
  // The badge in the nav counts EVERY pending appointment, not only those in
  // the range the calendar happens to be showing — a request from next month
  // still needs the owner's attention today.
  return c.json({ data, pendingCount })
})

/**
 * The four appointment actions.
 *
 * Every one of them delegates to appointmentService, which already owns the
 * status transitions, the Google Calendar mirror and the patient's WhatsApp —
 * the same code the owner's WhatsApp assistant runs. The panel is a second
 * caller of that logic, never a second copy of it.
 *
 * None of them message the OWNER (US-07 AC5): they are standing in the panel
 * looking at the result.
 */
panelRoutes.patch('/api/panel/:businessId/appointments/:id/approve', async (c) => {
  const result = await appointmentService.confirmAppointment({
    businessId: panelBusiness(c).id,
    appointmentId: c.req.param('id'),
  })
  const unwrapped = unwrap(c, result)
  if (!unwrapped.ok) return unwrapped.res

  return c.json({
    success: true,
    status: unwrapped.data.appointment.status,
    patientNotified: unwrapped.data.patientNotified,
    ...(unwrapped.data.patientNotifyError
      ? { patientNotifyError: unwrapped.data.patientNotifyError }
      : {}),
  })
})

panelRoutes.patch('/api/panel/:businessId/appointments/:id/reject', async (c) => {
  const body = await parseBody(c, reasonSchema)
  if (!body.ok) return body.res

  const result = await appointmentService.rejectAppointment({
    businessId: panelBusiness(c).id,
    appointmentId: c.req.param('id'),
    ...(body.data.reason ? { reason: body.data.reason } : {}),
  })
  const unwrapped = unwrap(c, result)
  if (!unwrapped.ok) return unwrapped.res

  return c.json({
    success: true,
    status: unwrapped.data.appointment.status,
    patientNotified: unwrapped.data.patientNotified,
  })
})

panelRoutes.patch('/api/panel/:businessId/appointments/:id/cancel', async (c) => {
  const body = await parseBody(c, reasonSchema)
  if (!body.ok) return body.res

  const result = await appointmentService.cancelAppointment({
    businessId: panelBusiness(c).id,
    appointmentId: c.req.param('id'),
    ...(body.data.reason ? { reason: body.data.reason } : {}),
  })
  const unwrapped = unwrap(c, result)
  if (!unwrapped.ok) return unwrapped.res

  return c.json({
    success: true,
    status: unwrapped.data.appointment.status,
    patientNotified: unwrapped.data.patientNotified,
  })
})

// The one action with no WhatsApp at all (US-07 AC3).
panelRoutes.patch('/api/panel/:businessId/appointments/:id/complete', async (c) => {
  const result = await appointmentService.completeAppointment({
    businessId: panelBusiness(c).id,
    appointmentId: c.req.param('id'),
  })
  const unwrapped = unwrap(c, result)
  if (!unwrapped.ok) return unwrapped.res

  return c.json({ success: true, status: unwrapped.data.status })
})

// ── Dashboard ────────────────────────────────────────────────────────────────

const statsSchema = z.object({
  period: z.enum(['today', 'week', 'month']).default('today'),
})

panelRoutes.get('/api/panel/:businessId/stats', async (c) => {
  const query = parseQuery(c, statsSchema)
  if (!query.ok) return query.res

  const window = panelService.statsWindow(query.data.period)
  const stats = await panelRepo.getStats(
    panelBusiness(c).id,
    window.from,
    window.to,
    window.prevFrom,
  )
  return c.json(stats)
})

panelRoutes.get('/api/panel/:businessId/stats/qualification-breakdown', async (c) => {
  return c.json(await panelRepo.getQualificationBreakdown(panelBusiness(c).id))
})

const activitySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
})

panelRoutes.get('/api/panel/:businessId/activity', async (c) => {
  const query = parseQuery(c, activitySchema)
  if (!query.ok) return query.res

  const data = await panelRepo.getActivity(panelBusiness(c).id, query.data.days)
  return c.json({ data })
})

// ── Customers ────────────────────────────────────────────────────────────────

const customersSchema = paginationSchema.extend({
  search: z.string().trim().max(100).optional(),
})

panelRoutes.get('/api/panel/:businessId/customers', async (c) => {
  const query = parseQuery(c, customersSchema)
  if (!query.ok) return query.res

  const page = await panelRepo.listCustomers(
    panelBusiness(c).id,
    query.data.search,
    query.data.page,
    query.data.limit,
  )
  return c.json(page)
})

panelRoutes.get('/api/panel/:businessId/customers/:customerId', async (c) => {
  const detail = await panelRepo.getCustomerDetail(panelBusiness(c).id, c.req.param('customerId'))
  if (!detail) return c.json({ error: 'not_found' }, 404)
  return c.json(detail)
})

// ── Meta ─────────────────────────────────────────────────────────────────────

// Everything the shell needs to render itself: the business name for the header,
// the niche that decides whether this business calls them Pacientes or Clientes,
// and the weekly hours the appointments calendar shades as working time. The
// token is never echoed back.
panelRoutes.get('/api/panel/:businessId/me', (c) => {
  const business = panelBusiness(c)
  return c.json({
    id: business.id,
    name: business.name,
    niche: panelService.nicheOf(business),
    ownerName: business.ownerName,
    timezone: business.timezone,
    operatingHours: panelService.operatingHoursOf(business),
  })
})

/**
 * Connection indicator.
 *
 * Reads the in-memory client registry, which is per-instance: with one Railway
 * container that is the truth, and the day this runs on two it becomes "is Emma
 * connected on the instance that answered you". Noted here because that is the
 * same limitation clientRegistry already carries for notifyOwner.
 */
panelRoutes.get('/api/panel/:businessId/health', (c) => {
  const state = getConnectionState(panelBusiness(c).id)
  if (!state) {
    logger.debug({ businessId: panelBusiness(c).id }, 'panel health: no connection state')
    return c.json({ connected: false, lastEventAt: null })
  }
  return c.json({
    connected: state.status === 'connected',
    status: state.status,
    lastEventAt: state.lastEventAt ? new Date(state.lastEventAt).toISOString() : null,
    // "desconectada hace X" is measured from when the current status began, not
    // from the last message — a number that has been quiet all morning is still
    // connected, and the header must not claim otherwise.
    ...(state.status === 'connected'
      ? {}
      : { downSince: new Date(state.statusSince).toISOString() }),
  })
})
