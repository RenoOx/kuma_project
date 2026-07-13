import { env } from '@/config/env.js'
import { logger } from '@/config/logger.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import { getConnectionState } from '@/modules/whatsapp/clientRegistry.js'
import type { Context } from 'hono'
import { Hono } from 'hono'
import qrcode from 'qrcode'
import * as dashRepo from './dashboard.repo.js'

export const dashboardRoutes = new Hono()

// ── Auth ──────────────────────────────────────────────────────────────────────

function getSecret(c: Context): string | null {
  if (!env.ADMIN_SECRET) return null
  const s = c.req.query('secret')
  return s === env.ADMIN_SECRET ? s : null
}

function unauthorized(c: Context): Response {
  if (!env.ADMIN_SECRET) {
    return c.html('<h1>501 — ADMIN_SECRET not configured</h1>', 501) as Response
  }
  return c.html('<h1>401 — Unauthorized</h1>', 401) as Response
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtDatetime(d: Date | null | undefined): string {
  if (!d) return '<span class="muted">—</span>'
  return esc(
    d.toLocaleString('es-PE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Lima',
    }),
  )
}

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '<span class="muted">—</span>'
  return esc(
    d.toLocaleString('es-PE', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'America/Lima',
    }),
  )
}

type WaStatus = 'connecting' | 'qr_pending' | 'connected' | 'logged_out'

function statusBadge(status: WaStatus | null | undefined): string {
  if (!status) {
    return '<span class="badge badge-gray"><span class="dot dot-gray"></span>Sin iniciar</span>'
  }
  const cfg: Record<WaStatus, { badge: string; dot: string; label: string }> = {
    connected: { badge: 'badge-green', dot: 'dot-green', label: 'Conectado' },
    qr_pending: { badge: 'badge-yellow', dot: 'dot-yellow', label: 'Pendiente' },
    connecting: { badge: 'badge-gray', dot: 'dot-gray', label: 'Conectando…' },
    logged_out: { badge: 'badge-red', dot: 'dot-red', label: 'Sesión cerrada' },
  }
  const c = cfg[status]
  return `<span class="badge ${c.badge}"><span class="dot ${c.dot}"></span>${c.label}</span>`
}

function apptStatusBadge(status: string): string {
  const cfg: Record<string, string> = {
    scheduled: 'badge-yellow',
    confirmed: 'badge-green',
    cancelled: 'badge-red',
    completed: 'badge-gray',
  }
  return `<span class="badge ${cfg[status] ?? 'badge-gray'}">${esc(status)}</span>`
}

function waActions(businessId: string, status: WaStatus | undefined, secret: string): string {
  const se = encodeURIComponent(secret)
  const pairUrl = `/admin/whatsapp/pair?secret=${se}&businessId=${esc(businessId)}`
  const qrUrl = `/admin/whatsapp/qr?secret=${se}&businessId=${esc(businessId)}`
  const connectUrl = `/admin/dashboard/${esc(businessId)}/connect?secret=${se}`

  if (status === 'connected') {
    return `<a href="${qrUrl}" class="btn btn-ghost btn-sm">Estado WA</a>`
  }
  if (status === 'qr_pending') {
    return `
      <a href="${pairUrl}" class="btn btn-primary btn-sm">Vincular</a>
      <a href="${qrUrl}" class="btn btn-ghost btn-sm">Ver QR</a>`
  }
  if (status === 'connecting') {
    return `<span class="badge badge-gray" style="font-size:11px">Iniciando…</span>`
  }
  // logged_out or null (never started)
  const label = status === 'logged_out' ? 'Reconectar' : 'Conectar'
  return `<form method="post" action="${connectUrl}" style="display:inline">
    <button type="submit" class="btn btn-warning btn-sm">${label}</button>
  </form>`
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#fafaf8;color:#0a0f0d;font-size:14px;line-height:1.6}
a{color:inherit;text-decoration:none}
.topbar{background:#fff;border-bottom:1px solid #e5e7eb;padding:0 1.5rem;display:flex;align-items:center;gap:1.5rem;height:52px;position:sticky;top:0;z-index:10}
.brand{font-weight:700;font-size:15px;letter-spacing:-0.01em}
.brand span{color:#059669}
.nav{display:flex;gap:2px;margin-left:auto}
.nav a{padding:.35rem .75rem;border-radius:6px;color:#6b7280;font-size:13px;font-weight:500}
.nav a:hover{background:#f3f4f6;color:#0a0f0d}
.nav a.active{background:#f0fdf4;color:#059669}
.main{max-width:1200px;margin:0 auto;padding:2rem 1.5rem}
.page-title{font-size:18px;font-weight:700;margin-bottom:1.5rem;letter-spacing:-0.02em}
.back{display:inline-flex;align-items:center;gap:.3rem;color:#9ca3af;font-size:13px;margin-bottom:1rem}
.back:hover{color:#6b7280}

.stats-row{display:flex;gap:1rem;margin-bottom:1.5rem;flex-wrap:wrap}
.stat-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:1rem 1.25rem;min-width:140px;flex:1}
.stat-label{font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em}
.stat-value{font-size:24px;font-weight:700;margin-top:.15rem}
.stat-accent{color:#059669}

.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;margin-bottom:1.5rem}
.card-header{padding:.875rem 1.25rem;border-bottom:1px solid #f3f4f6;display:flex;align-items:center;justify-content:space-between}
.card-title{font-size:13px;font-weight:600;color:#374151}
.card-body{padding:1.25rem}
.info-row{display:flex;gap:.5rem;margin-bottom:.5rem;align-items:baseline}
.info-label{font-size:12px;color:#9ca3af;width:120px;flex-shrink:0}
.info-value{font-size:13px;font-weight:500}

.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:.6rem .75rem;font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #f3f4f6;white-space:nowrap}
td{padding:.75rem;border-bottom:1px solid #f9fafb;vertical-align:middle;font-size:13px}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafaf8}
.biz-link{font-weight:600;color:#059669}
.biz-link:hover{color:#047857}
.muted{color:#9ca3af}
.mono{font-family:'SF Mono','Fira Code',monospace;font-size:12px}

.badge{display:inline-flex;align-items:center;gap:.3rem;padding:.2rem .55rem;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap}
.badge-green{background:#dcfce7;color:#15803d}
.badge-red{background:#fee2e2;color:#b91c1c}
.badge-yellow{background:#fef9c3;color:#a16207}
.badge-gray{background:#f3f4f6;color:#6b7280}
.dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.dot-green{background:#22c55e}
.dot-red{background:#ef4444}
.dot-yellow{background:#f59e0b}
.dot-gray{background:#9ca3af}

.btn{display:inline-flex;align-items:center;gap:.3rem;padding:.4rem .875rem;border-radius:6px;font-size:13px;font-weight:500;text-decoration:none;border:none;cursor:pointer;line-height:1;font-family:inherit;transition:background .1s}
.btn-primary{background:#059669;color:#fff}
.btn-primary:hover{background:#047857}
.btn-ghost{background:transparent;color:#374151;border:1px solid #e5e7eb}
.btn-ghost:hover{background:#f9fafb}
.btn-warning{background:#fffbeb;color:#b45309;border:1px solid #fcd34d}
.btn-warning:hover{background:#fef3c7}
.btn-sm{padding:.3rem .65rem;font-size:12px}
.actions{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap}

.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:900px){.grid-2{grid-template-columns:1fr}}
.empty{padding:2rem;text-align:center;color:#9ca3af;font-size:13px}

.session-card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:1.25rem;display:flex;align-items:flex-start;gap:1rem;margin-bottom:.75rem}
.session-card.connected{border-left:3px solid #059669}
.session-card.qr_pending{border-left:3px solid #f59e0b}
.session-card.logged_out{border-left:3px solid #ef4444}
.session-card.connecting,.session-card.none{border-left:3px solid #e5e7eb}
.session-info{flex:1;min-width:0}
.session-name{font-weight:600;font-size:14px;margin-bottom:.2rem}
.session-meta{color:#9ca3af;font-size:12px;margin-bottom:.5rem}
.session-actions{display:flex;gap:.5rem;align-items:center;flex-shrink:0}
.qr-img{display:block;margin:.75rem 0 0;border:1px solid #e5e7eb;border-radius:8px}
`

// ── Layout ────────────────────────────────────────────────────────────────────

function layout(
  title: string,
  body: string,
  secret: string,
  active: 'businesses' | 'sessions',
  refreshSecs?: number,
): string {
  const s = encodeURIComponent(secret)
  const refresh = refreshSecs ? `<meta http-equiv="refresh" content="${refreshSecs}">` : ''
  const navA = (href: string, label: string, page: string) =>
    `<a href="${href}?secret=${s}" class="${active === page ? 'active' : ''}">${label}</a>`

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  ${refresh}
  <title>Kuma Admin — ${esc(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
  <div class="topbar">
    <span class="brand">Kuma <span>Admin</span></span>
    <nav class="nav">
      ${navA('/admin/dashboard', 'Negocios', 'businesses')}
      ${navA('/admin/dashboard/sessions', 'Sesiones WA', 'sessions')}
    </nav>
  </div>
  <main class="main">
    ${body}
  </main>
</body>
</html>`
}

// ── Vista 1: Lista de negocios ────────────────────────────────────────────────

dashboardRoutes.get('/admin/dashboard', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const [all, statsMap] = await Promise.all([
    businessRepo.findAll(),
    dashRepo.getAllBusinessesStats(),
  ])

  if (all.length === 0) {
    const body = `
      <h1 class="page-title">Negocios</h1>
      <div class="card"><div class="empty">No hay negocios registrados.<br>Creá uno con la API admin (<code>POST /admin/businesses</code>).</div></div>`
    return c.html(layout('Negocios', body, secret, 'businesses'))
  }

  const se = encodeURIComponent(secret)
  const rows = all
    .map((b) => {
      const state = getConnectionState(b.id)
      const stats = statsMap.get(b.id) ?? {
        customerCount: 0,
        conversationCount: 0,
        appointmentCount: 0,
        lastMessageAt: null,
      }
      const status = state?.status as WaStatus | undefined
      return `<tr>
        <td>
          <a href="/admin/dashboard/${esc(b.id)}?secret=${se}" class="biz-link">${esc(b.name)}</a>
        </td>
        <td><span class="mono muted">${esc(b.whatsappNumber)}</span></td>
        <td>${statusBadge(status)}</td>
        <td style="text-align:right">${stats.customerCount}</td>
        <td style="text-align:right">${stats.conversationCount}</td>
        <td style="text-align:right">${stats.appointmentCount}</td>
        <td class="muted">${fmtDatetime(stats.lastMessageAt)}</td>
        <td>
          <div class="actions">
            ${waActions(b.id, status, secret)}
            <a href="/admin/dashboard/${esc(b.id)}?secret=${se}" class="btn btn-ghost btn-sm">Detalle</a>
          </div>
        </td>
      </tr>`
    })
    .join('')

  const body = `
    <h1 class="page-title">Negocios <span style="font-weight:400;color:#9ca3af;font-size:14px">(${all.length})</span></h1>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Negocio</th>
              <th>WhatsApp</th>
              <th>Estado WA</th>
              <th style="text-align:right">Clientes</th>
              <th style="text-align:right">Convs.</th>
              <th style="text-align:right">Citas</th>
              <th>Última actividad</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`

  // Auto-refresh if any session is transitioning
  const anyTransitioning = all.some((b) => {
    const s = getConnectionState(b.id)?.status
    return s === 'connecting' || s === 'qr_pending'
  })

  return c.html(layout('Negocios', body, secret, 'businesses', anyTransitioning ? 10 : undefined))
})

// ── Vista 3: Sesiones WA (antes que /:id para evitar conflicto de ruta) ───────

dashboardRoutes.get('/admin/dashboard/sessions', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const all = await businessRepo.findAll()
  const se = encodeURIComponent(secret)

  const hasTransitioning = all.some((b) => {
    const s = getConnectionState(b.id)?.status
    return s === 'connecting' || s === 'qr_pending'
  })

  const cards = await Promise.all(
    all.map(async (b) => {
      const state = getConnectionState(b.id)
      const status = state?.status as WaStatus | undefined
      const cardClass = status ?? 'none'

      let qrHtml = ''
      if (status === 'qr_pending' && state?.qr) {
        try {
          const dataUrl = await qrcode.toDataURL(state.qr, { width: 200, margin: 2 })
          qrHtml = `<img src="${dataUrl}" alt="QR" width="200" height="200" class="qr-img">`
        } catch (err) {
          logger.warn({ err, businessId: b.id }, 'dashboard: failed to generate QR data URL')
        }
      }

      const pairUrl = `/admin/whatsapp/pair?secret=${se}&businessId=${esc(b.id)}`

      return `<div class="session-card ${esc(cardClass)}">
        <div class="session-info">
          <div class="session-name">${esc(b.name)}</div>
          <div class="session-meta"><span class="mono">${esc(b.whatsappNumber)}</span></div>
          ${statusBadge(status)}
          ${qrHtml}
          ${status === 'qr_pending' ? `<div style="margin-top:.75rem"><a href="${pairUrl}" class="btn btn-primary btn-sm">Vincular con código</a></div>` : ''}
        </div>
        <div class="session-actions">
          ${waActions(b.id, status, secret)}
        </div>
      </div>`
    }),
  )

  const body = `
    <h1 class="page-title">Sesiones WhatsApp</h1>
    ${all.length === 0 ? '<div class="card"><div class="empty">No hay negocios registrados.</div></div>' : cards.join('')}`

  return c.html(
    layout('Sesiones WA', body, secret, 'sessions', hasTransitioning ? 8 : undefined),
  )
})

// ── Vista 2: Detalle de negocio ───────────────────────────────────────────────

dashboardRoutes.get('/admin/dashboard/:id', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const [business, detail] = await Promise.all([
    businessRepo.findById(businessId),
    dashRepo.getBusinessDetail(businessId),
  ])

  if (!business) {
    return c.html(
      layout('No encontrado', '<p class="muted">Negocio no encontrado.</p>', secret, 'businesses'),
      404,
    )
  }

  const state = getConnectionState(businessId)
  const status = state?.status as WaStatus | undefined
  const se = encodeURIComponent(secret)

  // Settings summary
  const settings = business.settings as Record<string, unknown>
  const botPaused = (settings?.botPaused as { paused?: boolean } | undefined)?.paused === true
  const services = Array.isArray(settings?.services)
    ? (settings.services as Array<{ name?: string }>)
    : []

  const customersRows =
    detail.recentCustomers.length === 0
      ? '<tr><td colspan="3" class="empty">Sin clientes todavía</td></tr>'
      : detail.recentCustomers
          .map(
            (cu) => `<tr>
            <td>${esc(cu.name ?? '—')}</td>
            <td><span class="mono muted">${esc(cu.phone)}</span></td>
            <td class="muted">${fmtDatetime(cu.lastSeenAt)}</td>
          </tr>`,
          )
          .join('')

  const apptRows =
    detail.recentAppointments.length === 0
      ? '<tr><td colspan="4" class="empty">Sin citas todavía</td></tr>'
      : detail.recentAppointments
          .map(
            (a) => `<tr>
            <td>${fmtDate(a.scheduledAt)}</td>
            <td>${esc(a.service)}</td>
            <td>${esc(a.customerName ?? a.customerPhone)}</td>
            <td>${apptStatusBadge(a.status)}</td>
          </tr>`,
          )
          .join('')

  const body = `
    <a href="/admin/dashboard?secret=${se}" class="back">← Negocios</a>
    <h1 class="page-title">${esc(business.name)}</h1>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Mensajes hoy</div>
        <div class="stat-value stat-accent">${detail.messagesToday}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Mensajes (7 días)</div>
        <div class="stat-value">${detail.messagesThisWeek}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Citas (7 días)</div>
        <div class="stat-value">${detail.appointmentsThisWeek}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Google Calendar</div>
        <div class="stat-value" style="font-size:14px;margin-top:.4rem">${detail.googleConnected ? '<span class="badge badge-green">Conectado</span>' : '<span class="badge badge-gray">Sin conectar</span>'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Bot</div>
        <div class="stat-value" style="font-size:14px;margin-top:.4rem">${botPaused ? '<span class="badge badge-red">Pausado</span>' : '<span class="badge badge-green">Activo</span>'}</div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header"><span class="card-title">Información del negocio</span></div>
        <div class="card-body">
          <div class="info-row"><span class="info-label">WhatsApp</span><span class="info-value mono">${esc(business.whatsappNumber)}</span></div>
          <div class="info-row"><span class="info-label">Dueño</span><span class="info-value">${esc(business.ownerName ?? '—')}</span></div>
          <div class="info-row"><span class="info-label">Tel. dueño</span><span class="info-value mono">${esc(business.ownerWhatsappNumber ?? '—')}</span></div>
          <div class="info-row"><span class="info-label">Zona horaria</span><span class="info-value">${esc(business.timezone)}</span></div>
          <div class="info-row"><span class="info-label">Servicios</span><span class="info-value">${services.length > 0 ? services.map((s) => esc(s.name ?? '')).join(', ') : '<span class="muted">Sin configurar</span>'}</span></div>
          <div class="info-row"><span class="info-label">Creado</span><span class="info-value">${fmtDate(business.createdAt)}</span></div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Sesión WhatsApp</span>
          ${statusBadge(status)}
        </div>
        <div class="card-body">
          <div class="actions">
            ${waActions(businessId, status, secret)}
            <a href="/admin/whatsapp/qr?secret=${se}&businessId=${esc(businessId)}" class="btn btn-ghost btn-sm">Ver estado completo</a>
          </div>
        </div>
      </div>
    </div>

    <div class="grid-2">
      <div class="card">
        <div class="card-header"><span class="card-title">Últimos clientes</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Nombre</th><th>Teléfono</th><th>Última vez</th></tr></thead>
            <tbody>${customersRows}</tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><span class="card-title">Últimas citas</span></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Fecha</th><th>Servicio</th><th>Cliente</th><th>Estado</th></tr></thead>
            <tbody>${apptRows}</tbody>
          </table>
        </div>
      </div>
    </div>`

  return c.html(layout(business.name, body, secret, 'businesses'))
})

// ── POST /:id/connect — arranca cliente WA y redirige a pair ─────────────────

dashboardRoutes.post('/admin/dashboard/:id/connect', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const business = await businessRepo.findById(businessId)
  if (!business) return c.html('<h1>404 — Not found</h1>', 404) as Response

  try {
    const { restartWhatsappFor } = await import('@/server.js')
    await restartWhatsappFor(business.id, business.whatsappNumber)
  } catch (err) {
    logger.error({ err, businessId }, 'dashboard: connect failed')
    return c.html(
      layout(
        'Error al conectar',
        `<a href="/admin/dashboard?secret=${encodeURIComponent(secret)}" class="back">← Negocios</a>
         <p style="color:#b91c1c;margin-top:1rem">No se pudo iniciar la sesión: ${esc((err as Error).message ?? 'error desconocido')}</p>`,
        secret,
        'businesses',
      ),
      500,
    )
  }

  const se = encodeURIComponent(secret)
  return c.redirect(`/admin/whatsapp/pair?secret=${se}&businessId=${esc(businessId)}`, 302)
})
