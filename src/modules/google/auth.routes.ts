import { logger } from '@/config/logger.js'
import * as businessService from '@/modules/business/business.service.js'
import { Hono } from 'hono'
import * as googleClient from './google.client.js'
import * as googleCredentialsRepo from './googleCredentials.repo.js'

export const googleAuthRoutes = new Hono()

// HTML rendering helpers. Tiny on purpose — these pages exist only so the
// user knows what happened after Google bounces them back. No CSS framework,
// no JS, no analytics.
function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${title} · Kuma</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 540px; margin: 4rem auto; padding: 0 1rem; line-height: 1.5; color: #222; }
    .ok { color: #1d6f42; }
    .err { color: #b3261e; }
    code { background: #f4f4f4; padding: 0.15em 0.35em; border-radius: 3px; }
  </style>
</head>
<body>
${body}
</body>
</html>`
}

googleAuthRoutes.get('/auth/google/connect', async (c) => {
  const businessId = c.req.query('businessId')
  if (!businessId) {
    return c.html(
      htmlPage('Falta businessId', '<h1 class="err">Falta el parámetro <code>businessId</code>.</h1>'),
      400,
    )
  }

  const businessResult = await businessService.getById(businessId)
  if (!businessResult.ok) {
    return c.html(
      htmlPage(
        'Negocio no encontrado',
        `<h1 class="err">No encontramos un negocio con id <code>${businessId}</code>.</h1>`,
      ),
      404,
    )
  }

  try {
    // V1: state = businessId. We trade CSRF resistance for simplicity until
    // there is an admin panel. The blast radius of a manipulated state is
    // attaching the wrong Google account to a business that the attacker
    // already knows the id of — acceptable while there's no public listing.
    const url = googleClient.getAuthUrl(businessId)
    return c.redirect(url)
  } catch (err) {
    logger.error({ err, businessId }, 'failed to build google auth url')
    return c.html(
      htmlPage(
        'OAuth no configurado',
        '<h1 class="err">Google OAuth no está configurado en el servidor.</h1><p>Pedile al administrador que setee <code>GOOGLE_CLIENT_ID</code> y <code>GOOGLE_CLIENT_SECRET</code>.</p>',
      ),
      500,
    )
  }
})

googleAuthRoutes.get('/auth/google/callback', async (c) => {
  const error = c.req.query('error')
  if (error) {
    return c.html(
      htmlPage(
        'Conexión cancelada',
        `<h1 class="err">No se conectó: <code>${error}</code></h1><p>Podés cerrar esta ventana e intentar de nuevo.</p>`,
      ),
      400,
    )
  }

  const code = c.req.query('code')
  const state = c.req.query('state')
  if (!code || !state) {
    return c.html(
      htmlPage(
        'Callback inválido',
        '<h1 class="err">Faltan parámetros del callback.</h1>',
      ),
      400,
    )
  }

  // Sanity-check that the state still maps to a real business — if a business
  // got deleted mid-flow, we should fail clean instead of writing dangling creds.
  const businessResult = await businessService.getById(state)
  if (!businessResult.ok) {
    return c.html(
      htmlPage(
        'Negocio inexistente',
        `<h1 class="err">El negocio <code>${state}</code> ya no existe.</h1>`,
      ),
      404,
    )
  }

  try {
    const tokens = await googleClient.exchangeCodeForTokens(code)
    const email = await googleClient.getUserEmail(tokens.accessToken)
    await googleCredentialsRepo.upsert({
      businessId: state,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenExpiresAt: tokens.expiryDate,
      calendarId: 'primary',
      connectedEmail: email,
    })
    logger.info(
      { businessId: state, connectedEmail: email },
      'google calendar connected for business',
    )
    return c.html(
      htmlPage(
        'Conectado',
        `<h1 class="ok">¡Conectado!</h1><p>Vinculamos <code>${email}</code> al negocio <code>${businessResult.data.name}</code>.</p><p>Ya podés cerrar esta ventana.</p>`,
      ),
    )
  } catch (err) {
    logger.error({ err, businessId: state }, 'google oauth callback failed')
    return c.html(
      htmlPage(
        'Error',
        `<h1 class="err">Hubo un problema completando la conexión.</h1><p>${err instanceof Error ? err.message : 'unknown error'}</p>`,
      ),
      500,
    )
  }
})
