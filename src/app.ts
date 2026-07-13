import { Hono } from 'hono'
import qrcode from 'qrcode'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { adminRoutes } from './modules/admin/admin.routes.js'
import { dashboardRoutes } from './modules/admin/dashboard.routes.js'
import { googleAuthRoutes } from './modules/google/auth.routes.js'
import * as businessRepo from './modules/business/business.repo.js'
import { getConnectionState, getClient, storePairingCode } from './modules/whatsapp/clientRegistry.js'

const VERSION = '0.1.0'

export const app = new Hono()

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: VERSION,
  })
})

app.route('/', googleAuthRoutes)

const STATUS_LABEL: Record<string, string> = {
  connecting: '⏳ Conectando',
  qr_pending: '📱 Escanear QR',
  connected: '✅ Conectado',
  logged_out: '❌ Sesión cerrada',
}

app.get('/admin/whatsapp/qr', async (c) => {
  if (!env.ADMIN_SECRET) {
    return c.html('<h1>501 — ADMIN_SECRET not configured</h1>', 501)
  }
  const secret = c.req.query('secret')
  if (secret !== env.ADMIN_SECRET) {
    return c.html('<h1>401 — Unauthorized</h1>', 401)
  }

  const businessId = c.req.query('businessId')

  // No businessId → index with all businesses and their connection status
  if (!businessId) {
    const all = await businessRepo.findAll()
    if (all.length === 0) {
      return c.html(
        renderPage('Sin negocios', '<p>No hay negocios registrados. Creá uno con la API admin.</p>'),
        200,
      )
    }
    const rows = all
      .map((b) => {
        const state = getConnectionState(b.id)
        const label = state ? (STATUS_LABEL[state.status] ?? state.status) : '⚫ Sin iniciar'
        const href = `/admin/whatsapp/qr?secret=${encodeURIComponent(secret ?? '')}&businessId=${b.id}`
        return `<tr>
          <td style="padding:0.5rem 1rem;text-align:left"><a href="${href}">${b.name}</a></td>
          <td style="padding:0.5rem 1rem;color:#555">${b.whatsappNumber}</td>
          <td style="padding:0.5rem 1rem">${label}</td>
        </tr>`
      })
      .join('')
    const body = `<table style="margin:1rem auto;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #ccc">
        <th style="padding:0.5rem 1rem;text-align:left">Negocio</th>
        <th style="padding:0.5rem 1rem">WhatsApp</th>
        <th style="padding:0.5rem 1rem">Estado</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
    return c.html(renderPage('Negocios', body, 15), 200)
  }

  // businessId provided → show QR for that business
  const state = getConnectionState(businessId)

  if (!state || state.status === 'logged_out') {
    return c.html(
      renderPage(
        'Sesión cerrada',
        '<p>WhatsApp cerró sesión. Borrá la carpeta de sesión y reiniciá el servidor.</p>',
      ),
      200,
    )
  }

  if (state.status === 'connected') {
    return c.html(
      renderPage('Conectado', '<p style="color:green;font-size:1.5rem">✅ WhatsApp conectado</p>'),
      200,
    )
  }

  if (state.status === 'connecting') {
    return c.html(renderPage('Iniciando...', '<p>Iniciando conexión…</p>', 5), 200)
  }

  // qr_pending
  if (!state.qr) {
    return c.html(renderPage('Esperando QR...', '<p>Generando QR…</p>', 3), 200)
  }

  const dataUrl = await qrcode.toDataURL(state.qr, { width: 300, margin: 2 })
  const pairHref = `/admin/whatsapp/pair?secret=${encodeURIComponent(secret ?? '')}&businessId=${businessId}`
  return c.html(
    renderPage(
      'Escanear QR',
      `<p>Escaneá este código con WhatsApp en tu teléfono.</p>
       <img src="${dataUrl}" alt="WhatsApp QR" style="display:block;margin:1rem auto"/>
       <p style="margin-top:1.5rem;font-size:0.9rem;color:#666">¿Problemas con el QR? <a href="${pairHref}">Usá código de texto</a></p>`,
      10,
    ),
    200,
  )
})

app.get('/admin/whatsapp/pair', async (c) => {
  if (!env.ADMIN_SECRET) {
    return c.html('<h1>501 — ADMIN_SECRET not configured</h1>', 501)
  }
  const secret = c.req.query('secret')
  if (secret !== env.ADMIN_SECRET) {
    return c.html('<h1>401 — Unauthorized</h1>', 401)
  }

  const businessId = c.req.query('businessId')

  if (!businessId) {
    const all = await businessRepo.findAll()
    if (all.length === 0) {
      return c.html(renderPage('Sin negocios', '<p>No hay negocios registrados.</p>'), 200)
    }
    const rows = all
      .map((b) => {
        const href = `/admin/whatsapp/pair?secret=${encodeURIComponent(secret ?? '')}&businessId=${b.id}`
        return `<tr>
          <td style="padding:0.5rem 1rem;text-align:left"><a href="${href}">${b.name}</a></td>
          <td style="padding:0.5rem 1rem;color:#555">${b.whatsappNumber}</td>
        </tr>`
      })
      .join('')
    const body = `<table style="margin:1rem auto;border-collapse:collapse">
      <thead><tr style="border-bottom:1px solid #ccc">
        <th style="padding:0.5rem 1rem;text-align:left">Negocio</th>
        <th style="padding:0.5rem 1rem">WhatsApp</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`
    return c.html(renderPage('Código de vinculación', body), 200)
  }

  const state = getConnectionState(businessId)
  if (state?.status === 'connected') {
    return c.html(
      renderPage('Conectado', '<p style="color:green;font-size:1.5rem">✅ WhatsApp conectado</p>'),
      200,
    )
  }

  const client = getClient(businessId)
  if (!client) {
    return c.html(
      renderPage('Sin cliente', '<p>El cliente de WhatsApp no está iniciado. Esperá unos segundos y recargá.</p>', 5),
      200,
    )
  }

  const refreshUrl = `?secret=${encodeURIComponent(secret ?? '')}&businessId=${businessId}`

  // Use the code that was auto-generated at socket startup (best timing).
  // Fall back to on-demand generation only when the user explicitly requests a new code.
  const forceNew = c.req.query('new') === '1'
  let code = state?.pairingCode ?? null

  if (!code || forceNew) {
    const business = await businessRepo.findById(businessId)
    if (!business) {
      return c.html(renderPage('Error', '<p>Negocio no encontrado.</p>'), 404)
    }
    try {
      code = await client.requestPairingCode(business.whatsappNumber)
      storePairingCode(businessId, code)
    } catch (err) {
      const msg = (err as Error).message ?? 'error desconocido'
      const isAlreadyRegistered = msg.toLowerCase().includes('already') || msg.toLowerCase().includes('registered')
      if (isAlreadyRegistered) {
        return c.html(
          renderPage('Ya vinculado', '<p style="color:green">✅ Este número ya tiene sesión activa. No es necesario vincular.</p>'),
          200,
        )
      }
      return c.html(
        renderPage('Error', `<p style="color:red">No se pudo generar el código: ${msg}</p><p><a href="${refreshUrl}">Reintentar</a></p>`),
        500,
      )
    }
  }

  if (!code) {
    return c.html(
      renderPage('Generando...', `<p>Generando código de vinculación…</p><p><a href="${refreshUrl}">Recargar</a></p>`, 3),
      200,
    )
  }

  // Format as XXXX-XXXX
  const formatted = code.replace(/[^A-Z0-9]/gi, '').toUpperCase().replace(/^(.{4})(.{4})$/, '$1-$2')

  const body = `
    <p style="margin-bottom:0.5rem">Abrí WhatsApp en el teléfono y seguí estos pasos:</p>
    <ol style="text-align:left;display:inline-block;margin:0.5rem auto 1.5rem">
      <li>Dispositivos vinculados</li>
      <li>Vincular dispositivo</li>
      <li>Vincular con número de teléfono</li>
      <li>Ingresá este código:</li>
    </ol>
    <div style="font-size:2.5rem;font-weight:bold;letter-spacing:0.2rem;margin:1rem auto;font-family:monospace;background:#f4f4f4;padding:1rem 2rem;border-radius:8px;display:inline-block">${formatted}</div>
    <p style="color:#888;font-size:0.85rem;margin-top:1rem">El código expira en ~60 segundos.</p>
    <p><a href="${refreshUrl}&new=1">Pedir código nuevo</a></p>`

  return c.html(renderPage('Código de vinculación', body, 60), 200)
})

function renderPage(title: string, body: string, refreshSecs?: number): string {
  const refresh = refreshSecs ? `<meta http-equiv="refresh" content="${refreshSecs}">` : ''
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">${refresh}
<title>Kuma — ${title}</title>
<style>body{font-family:sans-serif;max-width:480px;margin:3rem auto;text-align:center}</style>
</head><body><h1>WhatsApp — ${title}</h1>${body}</body></html>`
}

app.route('/', adminRoutes)
app.route('/', dashboardRoutes)

app.onError((err, c) => {
  logger.error({ err, path: c.req.path }, 'unhandled error')
  return c.json({ error: 'internal_error' }, 500)
})

app.notFound((c) => {
  return c.json({ error: 'not_found' }, 404)
})
