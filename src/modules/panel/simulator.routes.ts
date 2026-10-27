import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { env } from '@/config/env.js'
import { testVersionsFor } from '@/modules/conversation/flowSource.js'
import * as simulatorService from '@/modules/simulator/simulator.service.js'
import { type AppError, NotFoundError, ValidationError } from '@/shared/errors.js'
import { panelAuth, panelBusiness } from './panelAuth.js'

// La pestaña "Pruebas" del panel. El negocio sale SIEMPRE de panelAuth, nunca
// del cuerpo: un token solo puede simular conversaciones de su propio negocio.
//
// Existe con SIMULATOR_ENABLED (dev: todos los negocios) o, sin esa variable,
// para un negocio que tiene una versión en prueba en el repo (prod: solo esos).

export const panelSimulatorRoutes = new Hono()

panelSimulatorRoutes.use('/api/panel/:businessId/*', panelAuth)

// Nueve dígitos: es lo que newSessionId genera y lo que forma el teléfono falso.
const sessionIdSchema = z.string().regex(/^\d{9}$/)
// El `test.id` de una versión en prueba; null o ausente = la de siempre.
const versionSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,40}$/)
  .nullable()
  .optional()

const messageBodySchema = z.object({
  sessionId: sessionIdSchema,
  version: versionSchema,
  text: z.string().trim().min(1).max(2000),
})

// Las fotos no viajan: solo cuántas fueron (un grupo, como el DNI de frente y
// reverso) y el texto que las acompañaba.
const imagesBodySchema = z.object({
  sessionId: sessionIdSchema,
  version: versionSchema,
  count: z.number().int().min(1).max(10),
  caption: z.string().trim().max(1000).optional(),
})

const resumeBodySchema = z.object({ sessionId: sessionIdSchema })

function available(businessId: string): boolean {
  return env.SIMULATOR_ENABLED || testVersionsFor(businessId).length > 0
}

function disabled(c: Context): Response {
  return c.json(
    { error: 'not_found', message: 'El simulador no está habilitado.' },
    404,
  ) as Response
}

function invalidBody(c: Context, issues: unknown): Response {
  return c.json(
    { error: 'invalid_body', message: 'Datos inválidos.', details: issues },
    400,
  ) as Response
}

function failed(c: Context, error: AppError): Response {
  const status = error instanceof NotFoundError ? 404 : error instanceof ValidationError ? 400 : 500
  return c.json({ error: error.code, message: error.userMessage }, status) as Response
}

// El panel pregunta esto para decidir si muestra la página. Responde siempre,
// habilitado o no, para que el menú no dependa de un 404.
panelSimulatorRoutes.get('/api/panel/:businessId/simulator', (c) => {
  const businessId = panelBusiness(c).id
  return c.json({ enabled: available(businessId), versions: testVersionsFor(businessId) })
})

panelSimulatorRoutes.post('/api/panel/:businessId/simulator/sessions', (c) => {
  if (!available(panelBusiness(c).id)) return disabled(c)
  return c.json({ sessionId: simulatorService.newSessionId() }, 201)
})

panelSimulatorRoutes.post('/api/panel/:businessId/simulator/messages', async (c) => {
  if (!available(panelBusiness(c).id)) return disabled(c)

  const body = messageBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return invalidBody(c, body.error.issues)

  const result = await simulatorService.sendMessage(
    panelBusiness(c).id,
    body.data.sessionId,
    body.data.version ?? null,
    body.data.text,
  )
  if (!result.ok) return failed(c, result.error)
  return c.json(result.data)
})

panelSimulatorRoutes.post('/api/panel/:businessId/simulator/images', async (c) => {
  if (!available(panelBusiness(c).id)) return disabled(c)

  const body = imagesBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return invalidBody(c, body.error.issues)

  const result = await simulatorService.sendImages(
    panelBusiness(c).id,
    body.data.sessionId,
    body.data.version ?? null,
    body.data.count,
    body.data.caption || null,
  )
  if (!result.ok) return failed(c, result.error)
  return c.json(result.data)
})

panelSimulatorRoutes.post('/api/panel/:businessId/simulator/resume', async (c) => {
  if (!available(panelBusiness(c).id)) return disabled(c)

  const body = resumeBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return invalidBody(c, body.error.issues)

  const result = await simulatorService.resume(panelBusiness(c).id, body.data.sessionId)
  if (!result.ok) return failed(c, result.error)
  return c.json({ ok: true })
})
