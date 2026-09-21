import type { Context } from 'hono'
import { Hono } from 'hono'
import type { z } from 'zod'
import { logger } from '@/config/logger.js'
import * as mediaService from '@/modules/media/media.service.js'
import { MAX_MEDIA_BYTES } from '@/modules/media/media.validate.js'
import { isMediaConfigured } from '@/modules/media/s3.client.js'
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
): Promise<{ ok: true; buffer: Buffer } | { ok: false; res: Response }> {
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

  return { ok: true, buffer: Buffer.from(await file.arrayBuffer()) }
}

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

panelSettingsRoutes.patch('/api/panel/:businessId/settings/bot', async (c) => {
  const body = await parseBody(c, settingsService.botPatchSchema)
  if (!body.ok) return body.res
  return respond(c, await settingsService.updateBotPaused(panelBusiness(c).id, body.data))
})

// ── Service images ───────────────────────────────────────────────────────────
//
// Addressed by service id, which is why services carry one. The businessId comes
// from panelAuth and never from the request, and the S3 key is built from both by
// media.keys — so no request can name a path, and a presigned URL can only ever
// be issued for a key that came back out of this business's own settings.

panelSettingsRoutes.post('/api/panel/:businessId/settings/services/:serviceId/image', async (c) => {
  const business = panelBusiness(c)
  const serviceId = c.req.param('serviceId')

  const file = await parseMultipartFile(c)
  if (!file.ok) return file.res

  const uploaded = await mediaService.uploadMedia(
    { kind: 'service_image', businessId: business.id, serviceId },
    file.buffer,
  )
  if (!uploaded.ok) return failure(c, uploaded.error)

  const saved = await settingsService.updateServiceImage(business.id, serviceId, uploaded.data.key)
  if (!saved.ok) {
    // The object landed but nothing references it now. Drop it rather than
    // leave an orphan paid for by the founder's bill.
    const cleaned = await mediaService.removeMedia(business.id, uploaded.data.key)
    if (!cleaned.ok) {
      logger.warn(
        { businessId: business.id, serviceId, key: uploaded.data.key },
        'service image upload rolled back but the object could not be removed',
      )
    }
    return failure(c, saved.error)
  }

  // Keys are deterministic per service and extension, so replacing a jpg with
  // a jpg overwrites in place and there is nothing to clean up. Replacing a png
  // with a jpg leaves the old object behind, which is what this removes.
  const stale = saved.data.previousKey
  if (stale && stale !== uploaded.data.key) {
    const removed = await mediaService.removeMedia(business.id, stale)
    if (!removed.ok) {
      logger.warn(
        { businessId: business.id, serviceId, key: stale },
        'replaced service image but the previous object could not be removed',
      )
    }
  }

  const url = await mediaService.getPresignedUrl(business.id, uploaded.data.key)
  return c.json({ imageKey: uploaded.data.key, url: url.ok ? url.data : null })
})

panelSettingsRoutes.delete(
  '/api/panel/:businessId/settings/services/:serviceId/image',
  async (c) => {
    const business = panelBusiness(c)
    const serviceId = c.req.param('serviceId')

    const saved = await settingsService.updateServiceImage(business.id, serviceId, null)
    if (!saved.ok) return failure(c, saved.error)

    // Row first, object second: a service pointing at a deleted object shows the
    // owner a broken image, while an unreferenced object is only wasted bytes.
    if (saved.data.previousKey) {
      const removed = await mediaService.removeMedia(business.id, saved.data.previousKey)
      if (!removed.ok) {
        logger.warn(
          { businessId: business.id, serviceId, key: saved.data.previousKey },
          'service image cleared but the object could not be removed',
        )
      }
    }

    return c.json({ imageKey: null, url: null })
  },
)

// Signed on demand rather than alongside GET /settings: signing every service's
// photo on each load costs a signature per service and hands out URLs that expire
// before the owner opens the card that shows them.
panelSettingsRoutes.get('/api/panel/:businessId/settings/services/:serviceId/image', async (c) => {
  const business = panelBusiness(c)
  const serviceId = c.req.param('serviceId')

  const key = settingsService.findServiceImageKey(business, serviceId)
  if (!key.ok) return failure(c, key.error)
  if (!key.data) return c.json({ imageKey: null, url: null })

  const url = await mediaService.getPresignedUrl(business.id, key.data)
  if (!url.ok) return failure(c, url.error)
  return c.json({ imageKey: key.data, url: url.data })
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
