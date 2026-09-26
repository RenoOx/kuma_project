import type { Context } from 'hono'
import { Hono } from 'hono'
import { z } from 'zod'
import { env } from '@/config/env.js'
import * as simulatorService from '@/modules/simulator/simulator.service.js'
import { NotFoundError, ValidationError } from '@/shared/errors.js'
import { panelAuth, panelBusiness } from './panelAuth.js'

// La página "Probar Emma" del panel. El negocio sale SIEMPRE de panelAuth, nunca
// del cuerpo: un token solo puede simular conversaciones de su propio negocio.

export const panelSimulatorRoutes = new Hono()

panelSimulatorRoutes.use('/api/panel/:businessId/*', panelAuth)

const messageBodySchema = z.object({
  // Nueve dígitos: es lo que newSessionId genera y lo que forma el teléfono falso.
  sessionId: z.string().regex(/^\d{9}$/),
  text: z.string().trim().min(1).max(2000),
})

function disabled(c: Context): Response {
  return c.json(
    { error: 'not_found', message: 'El simulador no está habilitado.' },
    404,
  ) as Response
}

// El panel pregunta esto para decidir si muestra la página. Responde siempre,
// habilitado o no, para que el menú no dependa de un 404.
panelSimulatorRoutes.get('/api/panel/:businessId/simulator', (c) =>
  c.json({ enabled: env.SIMULATOR_ENABLED }),
)

panelSimulatorRoutes.post('/api/panel/:businessId/simulator/sessions', (c) => {
  if (!env.SIMULATOR_ENABLED) return disabled(c)
  return c.json({ sessionId: simulatorService.newSessionId() }, 201)
})

panelSimulatorRoutes.post('/api/panel/:businessId/simulator/messages', async (c) => {
  if (!env.SIMULATOR_ENABLED) return disabled(c)

  const body = messageBodySchema.safeParse(await c.req.json().catch(() => null))
  if (!body.success) {
    return c.json(
      { error: 'invalid_body', message: 'Datos inválidos.', details: body.error.issues },
      400,
    )
  }

  const result = await simulatorService.sendMessage(
    panelBusiness(c).id,
    body.data.sessionId,
    body.data.text,
  )
  if (!result.ok) {
    const status =
      result.error instanceof NotFoundError
        ? 404
        : result.error instanceof ValidationError
          ? 400
          : 500
    return c.json({ error: result.error.code, message: result.error.userMessage }, status)
  }
  return c.json(result.data)
})
