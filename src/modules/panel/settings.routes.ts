import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import type { ServiceMedia } from '@/db/schema/index.js'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'
import { NODE_CATALOG, requirementMet } from '@/modules/conversation/nodeCatalog.js'
import { presetFor } from '@/modules/conversation/stateMachine.js'
import * as mediaService from '@/modules/media/media.service.js'
import { MAX_MEDIA_BYTES } from '@/modules/media/media.validate.js'
import { isMediaConfigured } from '@/modules/media/s3.client.js'
import * as serviceMediaService from '@/modules/media/serviceMedia.service.js'
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
  // The two media codes are checked before the ValidationError branch they would
  // otherwise fall into: an oversized file and an unsupported one are different
  // problems for the owner, and 400 for both tells them nothing.
  const status =
    error.code === 'media_too_large'
      ? 413
      : error.code === 'media_unsupported_type'
        ? 415
        : error instanceof NotFoundError
          ? 404
          : error instanceof ValidationError
            ? 400
            : 500
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

// Multipart framing around a file at the size ceiling. Generous on purpose: this
// only decides when to refuse before reading the body, and the real check is
// validateMedia against the decoded bytes.
const MAX_UPLOAD_BYTES = MAX_MEDIA_BYTES + 64 * 1024

/**
 * Pulls the one uploaded file out of a multipart request.
 *
 * Content-Length is checked before `parseBody`, which buffers the whole body into
 * memory: without it, refusing a 500MB upload would still cost 500MB of RSS
 * first. A missing or lying header only means the ceiling lands later, in
 * validateMedia, against bytes that cannot lie.
 */
async function parseMultipartFile(
  c: Context,
): Promise<{ ok: true; buffer: Buffer; filename: string | null } | { ok: false; res: Response }> {
  const tooLarge = (): { ok: false; res: Response } => ({
    ok: false,
    res: c.json(
      { error: 'media_too_large', message: 'El archivo supera los 5MB.' },
      413,
    ) as Response,
  })

  const declared = Number(c.req.header('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) return tooLarge()

  const body = await c.req.parseBody().catch(() => null)
  const file = body?.file
  if (!(file instanceof File)) {
    return {
      ok: false,
      res: c.json(
        { error: 'invalid_body', message: 'Adjuntá un archivo en el campo "file".' },
        400,
      ) as Response,
    }
  }
  if (file.size > MAX_MEDIA_BYTES) return tooLarge()

  // The uploader's own name, kept because it is what the customer will see the
  // document called in WhatsApp. It never reaches a path: the S3 key is built
  // from validated ids, so a name like "../../etc/passwd" is just a label.
  const filename = typeof file.name === 'string' && file.name.trim() !== '' ? file.name : null
  return { ok: true, buffer: Buffer.from(await file.arrayBuffer()), filename }
}

/** The arrangement the owner dragged into place, sent whole. */
const reorderSchema = z.object({
  ids: z.array(z.string().min(1).max(64)).max(32),
})

// ── Read ─────────────────────────────────────────────────────────────────────

panelSettingsRoutes.get('/api/panel/:businessId/settings', (c) => {
  // mediaConfigured is added here rather than inside readSettings so that
  // projection stays a pure function of the business row. The services form uses
  // it to explain a disabled upload instead of failing once the file is picked.
  return c.json({
    ...settingsService.readSettings(panelBusiness(c)),
    mediaConfigured: isMediaConfigured(),
  })
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
  const result = await settingsService.updateGeneral(panelBusiness(c).id, body.data)
  if (!result.ok) return failure(c, result.error)
  // Answers the same shape as GET /settings, mediaConfigured included: this is the
  // one section PATCH that returns the whole view, and a response that dropped a
  // field the GET has would make the two disagree for no reason.
  return c.json({ ...result.data, mediaConfigured: isMediaConfigured() })
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

// The Asistente tab: three cards, three PATCHes. Three rather than one because
// each card has its own Guardar, and a single section would bring back at a larger
// scale the reset-by-omission bug `patchable` exists to prevent — a save from the
// Mensajes card would arrive with no `assistant` and be read as "clear it".

panelSettingsRoutes.patch('/api/panel/:businessId/settings/identity', async (c) => {
  const body = await parseBody(c, settingsService.identityPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateIdentity(panelBusiness(c).id, body.data))
})

panelSettingsRoutes.patch('/api/panel/:businessId/settings/messages', async (c) => {
  const body = await parseBody(c, settingsService.messagesPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateMessages(panelBusiness(c).id, body.data))
})

panelSettingsRoutes.patch('/api/panel/:businessId/settings/flow', async (c) => {
  const body = await parseBody(c, settingsService.flowPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateFlow(panelBusiness(c).id, body.data))
})

// The Conversación card. Its own PATCH for the same reason the three above have
// theirs, plus one of its own: this is the only section whose payload can be
// refused for a reason Zod cannot see, so its handler is the only one that can
// answer "no" with a sentence naming the step that broke.
panelSettingsRoutes.patch('/api/panel/:businessId/settings/conversation', async (c) => {
  const body = await parseBody(c, settingsService.conversationPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateConversationFlow(panelBusiness(c).id, body.data))
})

/**
 * The brick box, for the panel to render.
 *
 * Served rather than duplicated in the SPA: the catalogue is the contract
 * between what the owner composes and what Emma runs, and a second copy in the
 * browser would drift the first time a node's steps change. Only the fields the
 * card shows — the wording and what the owner may override — never the tools or
 * the transitions, which are not theirs to see or to touch.
 */
panelSettingsRoutes.get('/api/panel/:businessId/settings/conversation/catalog', (c) => {
  const business = panelBusiness(c)
  const parsed = businessSettingsSchema.safeParse(business.settings)
  const settings = parsed.success ? parsed.data : null

  return c.json({
    nodes: NODE_CATALOG.map((bp) => ({
      id: bp.id,
      label: bp.label,
      hint: bp.hint,
      objective: bp.node.objective,
      steps: bp.node.steps,
      defaultEdgeCases: bp.node.edgeCases,
      defaultExample: bp.node.example,
      mandatory: bp.mandatory ?? false,
      // What the owner sees greyed out, with the reason: a node whose config is
      // missing is more useful shown-and-explained than silently absent.
      available: (bp.requires ?? []).every((r) => requirementMet(r, settings)),
      requires: bp.requires ?? [],
    })),
    // What runs right now, composed or derived. The card opens on this rather
    // than on an empty list, so the owner edits their actual flow instead of
    // building one from scratch.
    current: settings?.conversationFlow ?? presetFor(settings),
  })
})

panelSettingsRoutes.patch('/api/panel/:businessId/settings/bot', async (c) => {
  const body = await parseBody(c, settingsService.botPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateBotPaused(panelBusiness(c).id, body.data))
})

// ── Service media ────────────────────────────────────────────────────────────
//
// Addressed by service id, which is why services carry one. The businessId comes
// from panelAuth and never from the request, and the S3 key is built from both by
// media.keys — so no request can name a path, and a presigned URL can only ever
// be issued for a key that came back out of this business's own rows.
//
// Every write goes through serviceMedia.service, which is the only place that
// orders the bucket and the table so neither is left holding a file the other
// does not know about.

/** One row, as the panel renders it: never the key, always a signed URL. */
async function toView(businessId: string, row: ServiceMedia) {
  const url = await mediaService.getPresignedUrl(businessId, row.s3Key)
  return {
    id: row.id,
    serviceId: row.serviceId,
    type: row.type,
    filename: row.filename,
    mimetype: row.mimetype,
    sizeBytes: row.sizeBytes,
    displayOrder: row.displayOrder,
    // Null rather than an error: one unsignable object must not blank the list.
    url: url.ok ? url.data : null,
  }
}

panelSettingsRoutes.get('/api/panel/:businessId/settings/services/:serviceId/media', async (c) => {
  const business = panelBusiness(c)
  const rows = await serviceMediaService.listForService(business.id, c.req.param('serviceId'))
  return c.json(await Promise.all(rows.map((row) => toView(business.id, row))))
})

panelSettingsRoutes.post('/api/panel/:businessId/settings/services/:serviceId/media', async (c) => {
  const business = panelBusiness(c)
  const serviceId = c.req.param('serviceId')

  // The service has to exist before a file can hang off it, or the upload would
  // land in the bucket under an id nothing references — exactly the orphan this
  // whole path is built to avoid.
  const known = settingsService.serviceExists(business, serviceId)
  if (!known.ok) return failure(c, known.error)

  const file = await parseMultipartFile(c)
  if (!file.ok) return file.res

  const added = await serviceMediaService.addMedia({
    businessId: business.id,
    serviceId,
    filename: file.filename,
    buffer: file.buffer,
  })
  if (!added.ok) return failure(c, added.error)
  return c.json(await toView(business.id, added.data))
})

panelSettingsRoutes.delete(
  '/api/panel/:businessId/settings/services/:serviceId/media/:mediaId',
  async (c) => {
    const business = panelBusiness(c)
    const removed = await serviceMediaService.removeOne(business.id, c.req.param('mediaId'))
    if (!removed.ok) return failure(c, removed.error)
    return c.json({ id: removed.data.id })
  },
)

panelSettingsRoutes.patch(
  '/api/panel/:businessId/settings/services/:serviceId/media/order',
  async (c) => {
    const business = panelBusiness(c)
    const body = await parseBody(c, reorderSchema)
    if (!body.ok) return body.res

    const reordered = await serviceMediaService.reorder(
      business.id,
      c.req.param('serviceId'),
      body.data.ids,
    )
    if (!reordered.ok) return failure(c, reordered.error)
    return c.json(await Promise.all(reordered.data.map((row) => toView(business.id, row))))
  },
)

// ── Integrations ─────────────────────────────────────────────────────────────
//
// Read-only, and with no write counterpart by design. Pairing or dropping a
// WhatsApp session is not reachable from the panel: the credential here is a
// token in a URL, and a mis-click behind it would take the business's own
// number off WhatsApp. Those actions stay in the admin surface.

panelSettingsRoutes.get('/api/panel/:businessId/integrations', async (c) => {
  return c.json(await settingsService.readIntegrations(panelBusiness(c)))
})
