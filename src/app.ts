import { type Context, Hono } from 'hono'
import qrcode from 'qrcode'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import { adminRoutes } from './modules/admin/admin.routes.js'
import { dashboardRoutes } from './modules/admin/dashboard.routes.js'
import * as businessRepo from './modules/business/business.repo.js'
import { googleAuthRoutes } from './modules/google/auth.routes.js'
import {
  getClient,
  getConnectionState,
  storePairingCode,
} from './modules/whatsapp/clientRegistry.js'
import * as sessionGuard from './modules/whatsapp/sessionGuard.service.js'
import { SessionGuardError } from './shared/errors.js'

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
        renderPage(
          'Sin negocios',
          '<p>No hay negocios registrados. Creá uno con la API admin.</p>',
        ),
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

  // "No state" is now a normal condition: creating a business no longer boots a
  // socket, so a business that has never been linked lands here. Point at the
  // Connect button instead of the old "delete the session folder and restart the
  // server" advice, which was destructive and wrong for this case.
  if (!state) {
    return c.html(
      renderPage(
        'Sin iniciar',
        `<p>Este negocio todavía no inició sesión de WhatsApp.</p>
         <p style="margin-top:1rem">Andá al panel y usá el botón <strong>Conectar</strong> del negocio para generar el QR.</p>
         <p style="margin-top:1.5rem"><a href="/admin/dashboard?secret=${encodeURIComponent(secret ?? '')}">← Ir al panel</a></p>`,
      ),
      200,
    )
  }

  if (state.status === 'logged_out') {
    return c.html(
      renderPage(
        'Sesión cerrada',
        `<p>La sesión de WhatsApp está cerrada.</p>
         <p style="margin-top:1rem">Usá el botón <strong>Conectar</strong> del panel para reintentar la vinculación.</p>
         <p style="margin-top:1.5rem"><a href="/admin/dashboard?secret=${encodeURIComponent(secret ?? '')}">← Ir al panel</a></p>`,
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

  const qrBase = `/admin/whatsapp/qr?secret=${encodeURIComponent(secret ?? '')}&businessId=${businessId}`
  const cycle = refreshCycle(c)
  const nextUrl = nextRefreshUrl(qrBase, cycle)

  if (state.status === 'connecting') {
    return c.html(
      renderPage(
        'Iniciando...',
        `<p>Iniciando conexión…</p>${nextUrl ? '' : REFRESH_STOPPED_NOTE}`,
        nextUrl ? 5 : undefined,
        nextUrl ?? undefined,
      ),
      200,
    )
  }

  // qr_pending
  if (!state.qr) {
    return c.html(
      renderPage(
        'Esperando QR...',
        `<p>Generando QR…</p>${nextUrl ? '' : REFRESH_STOPPED_NOTE}`,
        nextUrl ? 3 : undefined,
        nextUrl ?? undefined,
      ),
      200,
    )
  }

  const dataUrl = await qrcode.toDataURL(state.qr, { width: 300, margin: 2 })
  return c.html(
    renderPage(
      'Escanear QR',
      `<p>Escaneá este código con WhatsApp en tu teléfono.</p>
       <img src="${dataUrl}" alt="WhatsApp QR" style="display:block;margin:1rem auto"/>
       ${nextUrl ? '' : REFRESH_STOPPED_NOTE}`,
      nextUrl ? 10 : undefined,
      nextUrl ?? undefined,
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
      renderPage(
        'Sin cliente',
        '<p>El cliente de WhatsApp no está iniciado. Esperá unos segundos y recargá.</p>',
        5,
      ),
      200,
    )
  }

  const refreshUrl = `?secret=${encodeURIComponent(secret ?? '')}&businessId=${businessId}`

  // Requesting a pairing code is an EXPLICIT act, never a side effect of loading
  // this page. It used to fire whenever no code was cached — and since booting a
  // socket resets the cached code, and this page auto-refreshed on a timer, the
  // page asked WhatsApp for a new code roughly every 90s on its own. Five of
  // those trip the circuit breaker: six hours blocked without anyone clicking
  // anything. The QR flow is the supported path now; this one waits for a click.
  const forceNew = c.req.query('new') === '1'
  let code = state?.pairingCode ?? null

  if (!code && !forceNew) {
    return c.html(
      renderPage(
        'Código de vinculación',
        `<p>Generá un código para vincular este número.</p>
         <p style="font-size:.85rem;color:#888;margin:1rem 0">
           Cada código pedido cuenta contra el límite de WhatsApp para el número.
           Pedí uno solo cuando tengas el teléfono en la mano.
         </p>
         <p><a href="${refreshUrl}&new=1" class="btn">Generar código de vinculación</a></p>`,
      ),
      200,
    )
  }

  if (forceNew || !code) {
    const business = await businessRepo.findById(businessId)
    if (!business) {
      return c.html(renderPage('Error', '<p>Negocio no encontrado.</p>'), 404)
    }

    // Guard EVERY path that reaches WhatsApp, not just the explicit "new code"
    // button. This page auto-refreshes, so an unguarded cached-miss branch
    // would quietly request a fresh pairing code on a timer — the fastest way
    // to get a number rate-limited.
    try {
      await sessionGuard.assertCanRequestPairingCode(business.whatsappNumber)
    } catch (err) {
      if (err instanceof SessionGuardError) {
        return renderGuardBlocked(c, err, refreshUrl)
      }
      throw err
    }

    try {
      code = await client.requestPairingCode(business.whatsappNumber)
      await sessionGuard.recordPairingCode(business.whatsappNumber, business.id)
      storePairingCode(businessId, code)
    } catch (err) {
      const msg = (err as Error).message ?? 'error desconocido'
      const isAlreadyRegistered =
        msg.toLowerCase().includes('already') || msg.toLowerCase().includes('registered')
      if (isAlreadyRegistered) {
        return c.html(
          renderPage(
            'Ya vinculado',
            '<p style="color:green">✅ Este número ya tiene sesión activa. No es necesario vincular.</p>',
          ),
          200,
        )
      }
      return c.html(
        renderPage(
          'Error',
          `<p style="color:red">No se pudo generar el código: ${msg}</p><p><a href="${refreshUrl}">Reintentar</a></p>`,
        ),
        500,
      )
    }
  }

  if (!code) {
    return c.html(
      renderPage(
        'Sin código',
        `<p>No se pudo obtener un código.</p><p><a href="${refreshUrl}&new=1">Generar código nuevo</a></p>`,
      ),
      200,
    )
  }

  // Format as XXXX-XXXX
  const formatted = code
    .replace(/[^A-Z0-9]/gi, '')
    .toUpperCase()
    .replace(/^(.{4})(.{4})$/, '$1-$2')

  // No auto-refresh here. This page used to reload every 60s, and a reload with
  // no cached code meant another request to WhatsApp. Expiry is handled by the
  // operator pressing the button below.
  const body = `
    <p style="margin-bottom:0.5rem">Abrí WhatsApp en el teléfono y seguí estos pasos:</p>
    <ol style="text-align:left;display:inline-block;margin:0.5rem auto 1.5rem">
      <li>Dispositivos vinculados</li>
      <li>Vincular dispositivo</li>
      <li>Vincular con número de teléfono</li>
      <li>Ingresá este código:</li>
    </ol>
    <div style="font-size:2.5rem;font-weight:bold;letter-spacing:0.2rem;margin:1rem auto;font-family:monospace;background:#f4f4f4;padding:1rem 2rem;border-radius:8px;display:inline-block">${formatted}</div>
    <p style="color:#888;font-size:0.85rem;margin-top:1rem">
      El código expira en ~60 segundos. Si venció, generá uno nuevo — no recargues la página en bucle.
    </p>
    <p style="margin-top:1.5rem">
      <a href="${refreshUrl}&new=1" style="color:#059669;font-size:0.9rem">Generar nuevo código</a>
    </p>`

  return c.html(renderPage('Código de vinculación', body), 200)
})

function renderPage(
  title: string,
  body: string,
  refreshSecs?: number,
  refreshUrl?: string,
): string {
  const content = refreshUrl ? `${refreshSecs};url=${refreshUrl}` : `${refreshSecs}`
  const refresh = refreshSecs ? `<meta http-equiv="refresh" content="${content}">` : ''
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8">${refresh}
<title>Emma — ${title}</title>
<style>body{font-family:sans-serif;max-width:480px;margin:3rem auto;text-align:center}</style>
</head><body><h1>WhatsApp — ${title}</h1>${body}</body></html>`
}

// A linking page left open in a tab used to auto-refresh forever, keeping a
// pairing socket alive indefinitely. Cap the cycles and make the operator opt
// back in by reloading.
const MAX_AUTO_REFRESH_CYCLES = 20

function refreshCycle(c: Context): number {
  const raw = Number.parseInt(c.req.query('r') ?? '0', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

/**
 * Builds the URL for the next auto-refresh, or null once the budget is spent.
 * `base` must already carry secret/businessId.
 */
function nextRefreshUrl(base: string, cycle: number): string | null {
  if (cycle >= MAX_AUTO_REFRESH_CYCLES) return null
  const sep = base.includes('?') ? '&' : '?'
  return `${base}${sep}r=${cycle + 1}`
}

const REFRESH_STOPPED_NOTE = `<p style="margin-top:1.5rem;font-size:.85rem;color:#888">
  La actualización automática se detuvo para no mantener la sesión abierta de más.
  <a href="javascript:location.reload()">Actualizar manualmente</a>
</p>`

/** Renders a SessionGuardError as a countdown (cooldown) or a hard stop (block). */
function renderGuardBlocked(c: Context, err: SessionGuardError, backUrl: string): Response {
  const secs = Math.ceil(err.retryAfterMs / 1000)

  if (err.reason === 'cooldown') {
    // Static countdown, no timer. This page used to redirect itself back to the
    // pairing page when the countdown hit zero — and that page then asked
    // WhatsApp for another code, which bounced back here. The loop drove roughly
    // one real pairing request every 90s until the breaker tripped at five.
    return c.html(
      renderPage(
        'Espera un momento',
        `<p style="color:#b45309">⏳ Podés pedir un nuevo código en <strong>${secs}</strong> segundos.</p>
         <p style="font-size:.85rem;color:#888">WhatsApp bloquea los números que piden códigos muy seguido.</p>
         <p style="margin-top:1.5rem"><a href="${backUrl}">← Volver</a></p>`,
      ),
      429,
    ) as Response
  }

  const hours = Math.floor(secs / 3600)
  const mins = Math.ceil((secs % 3600) / 60)
  const wait = hours > 0 ? `${hours}h ${mins}min` : `${mins} min`
  return c.html(
    renderPage(
      'Vinculación bloqueada',
      `<p style="color:#b91c1c;font-size:1.1rem">🛑 Este número está bloqueado por protección anti-ban.</p>
       <p>Se hicieron demasiados intentos de vinculación. Reintentar ahora puede hacer que
          WhatsApp banee el número de forma permanente.</p>
       <p style="margin-top:1rem"><strong>Podés reintentar en ${wait}.</strong></p>
       <p style="font-size:.85rem;color:#888;margin-top:1.5rem">
         Si estás seguro de que es un falso positivo, un admin puede forzar el desbloqueo con
         <code>POST /admin/businesses/:id/session/force-unblock</code>.
       </p>
       <p><a href="${backUrl}">← Volver</a></p>`,
    ),
    429,
  ) as Response
}

app.route('/', dashboardRoutes)
app.route('/', adminRoutes)

app.onError((err, c) => {
  logger.error({ err, path: c.req.path }, 'unhandled error')
  return c.json({ error: 'internal_error' }, 500)
})

app.notFound((c) => {
  return c.json({ error: 'not_found' }, 404)
})
