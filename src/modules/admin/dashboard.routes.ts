import { env } from '@/config/env.js'
import { logger } from '@/config/logger.js'
import {
  businessSettingsSchema,
  type BusinessSettings,
  type DayKey,
} from '@/modules/business/business.settings.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import * as businessService from '@/modules/business/business.service.js'
import {
  getConnectionState,
  setConnectionStatus,
} from '@/modules/whatsapp/clientRegistry.js'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { rm } from 'node:fs/promises'
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
  const bid = esc(businessId)
  const pairUrl = `/admin/whatsapp/pair?secret=${se}&businessId=${bid}`
  const qrUrl = `/admin/whatsapp/qr?secret=${se}&businessId=${bid}`
  const connectUrl = `/admin/dashboard/${bid}/connect?secret=${se}`
  const disconnectUrl = `/admin/dashboard/${bid}/disconnect?secret=${se}`

  if (status === 'connected') {
    return `
      <form method="post" action="${disconnectUrl}" style="display:inline"
        onsubmit="return confirm('¿Desconectar WhatsApp de este negocio? El bot dejará de responder.')">
        <button type="submit" class="btn btn-danger btn-sm">Desconectar</button>
      </form>
      <a href="${qrUrl}" class="btn btn-ghost btn-sm">Estado WA</a>`
  }
  if (status === 'qr_pending') {
    return `
      <a href="${pairUrl}" class="btn btn-primary btn-sm">Vincular</a>
      <a href="${qrUrl}" class="btn btn-ghost btn-sm">Ver QR</a>`
  }
  if (status === 'connecting') {
    return `<span class="badge badge-gray" style="font-size:11px">Iniciando…</span>`
  }
  const label = status === 'logged_out' ? 'Reconectar' : 'Conectar'
  return `<form method="post" action="${connectUrl}" style="display:inline">
    <button type="submit" class="btn btn-warning btn-sm">${label}</button>
  </form>`
}

// ── Settings form helpers ─────────────────────────────────────────────────────

const DAYS: Array<{ key: DayKey; label: string }> = [
  { key: 'monday', label: 'Lunes' },
  { key: 'tuesday', label: 'Martes' },
  { key: 'wednesday', label: 'Miércoles' },
  { key: 'thursday', label: 'Jueves' },
  { key: 'friday', label: 'Viernes' },
  { key: 'saturday', label: 'Sábado' },
  { key: 'sunday', label: 'Domingo' },
]

type DayHours = { open: string; close: string; break?: { start: string; end: string } } | null

function renderDayRow(key: DayKey, label: string, hours: DayHours): string {
  const enabled = hours !== null
  const open = hours?.open ?? '09:00'
  const close = hours?.close ?? '18:00'
  const hasBreak = !!hours?.break
  const bStart = hours?.break?.start ?? '13:00'
  const bEnd = hours?.break?.end ?? '14:00'
  const dis = enabled ? '' : 'disabled'
  const bDis = (enabled && hasBreak) ? '' : 'disabled'

  return `<tr>
    <td style="font-weight:500;padding-right:.5rem">${label}</td>
    <td style="text-align:center">
      <input type="checkbox" name="day_${key}_enabled" id="day_${key}_enabled"
        ${enabled ? 'checked' : ''} onchange="toggleDay('${key}')">
    </td>
    <td><input type="time" class="time-input" name="day_${key}_open" id="day_${key}_open"
      value="${open}" ${dis}></td>
    <td><input type="time" class="time-input" name="day_${key}_close" id="day_${key}_close"
      value="${close}" ${dis}></td>
    <td style="text-align:center">
      <input type="checkbox" name="day_${key}_break" id="day_${key}_break"
        ${hasBreak ? 'checked' : ''} ${dis} onchange="toggleBreak('${key}')">
    </td>
    <td><input type="time" class="time-input" name="day_${key}_break_start"
      id="day_${key}_break_start" value="${bStart}" ${bDis}></td>
    <td><input type="time" class="time-input" name="day_${key}_break_end"
      id="day_${key}_break_end" value="${bEnd}" ${bDis}></td>
  </tr>`
}

function renderServiceRows(services: Array<{ name: string; durationMinutes: number }>): string {
  if (services.length === 0) {
    return `<div class="service-row" id="service-row-0">
      <input type="text" class="form-input" name="service_0_name" data-field="name"
        placeholder="ej. Corte de cabello" style="flex:1">
      <input type="number" class="form-input" name="service_0_duration" data-field="duration"
        min="5" max="480" value="30" placeholder="Min" style="width:80px">
      <button type="button" class="btn btn-ghost btn-sm" onclick="removeService(this)">✕</button>
    </div>`
  }
  return services
    .map(
      (s, i) => `<div class="service-row" id="service-row-${i}">
      <input type="text" class="form-input" name="service_${i}_name" data-field="name"
        value="${esc(s.name)}" placeholder="ej. Corte de cabello" style="flex:1" required>
      <input type="number" class="form-input" name="service_${i}_duration" data-field="duration"
        min="5" max="480" value="${s.durationMinutes}" placeholder="Min" style="width:80px">
      <button type="button" class="btn btn-ghost btn-sm" onclick="removeService(this)">✕</button>
    </div>`,
    )
    .join('')
}

async function parseSettingsFromForm(
  formData: FormData,
): Promise<{ ok: true; data: BusinessSettings } | { ok: false; errors: string[] }> {
  const operatingHours: Record<string, unknown> = {}
  for (const { key } of DAYS) {
    const enabled = formData.get(`day_${key}_enabled`) === 'on'
    if (!enabled) {
      operatingHours[key] = null
      continue
    }
    const open = formData.get(`day_${key}_open`)?.toString() ?? ''
    const close = formData.get(`day_${key}_close`)?.toString() ?? ''
    const hasBreak = formData.get(`day_${key}_break`) === 'on'
    const day: Record<string, unknown> = { open, close }
    if (hasBreak) {
      day.break = {
        start: formData.get(`day_${key}_break_start`)?.toString() ?? '',
        end: formData.get(`day_${key}_break_end`)?.toString() ?? '',
      }
    }
    operatingHours[key] = day
  }

  const slotDuration = Number(formData.get('slotDurationMinutes') ?? 30)
  const minNoticeRaw = formData.get('minBookingNoticeMinutes')?.toString()
  const minNotice = minNoticeRaw ? Number(minNoticeRaw) : undefined

  const serviceCount = Number(formData.get('service_count') ?? 0)
  const services: Array<{ name: string; durationMinutes: number }> = []
  for (let i = 0; i < serviceCount; i++) {
    const name = formData.get(`service_${i}_name`)?.toString().trim() ?? ''
    const duration = Number(formData.get(`service_${i}_duration`) ?? 30)
    if (name) services.push({ name, durationMinutes: isNaN(duration) ? 30 : duration })
  }

  const raw = {
    operatingHours,
    slotDurationMinutes: isNaN(slotDuration) ? 30 : slotDuration,
    services,
    ...(minNotice !== undefined && !isNaN(minNotice) ? { minBookingNoticeMinutes: minNotice } : {}),
  }

  const parsed = businessSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) =>
        i.path.length === 0 ? i.message : `${i.path.join('.')}: ${i.message}`,
      ),
    }
  }
  return { ok: true, data: parsed.data }
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#fafaf8;color:#0a0f0d;font-size:14px;line-height:1.6}
a{color:inherit;text-decoration:none}
.topbar{background:#0a0f0d;border-bottom:1px solid #1a2b24;padding:0 1.5rem;display:flex;align-items:center;gap:1.5rem;height:52px;position:sticky;top:0;z-index:10}
.brand{font-weight:700;font-size:15px;letter-spacing:-0.01em;color:#059669}
.brand span{color:#d4b896}
.nav{display:flex;gap:2px;margin-left:auto}
.nav a{padding:.35rem .75rem;border-radius:6px;color:#d4b896;font-size:13px;font-weight:500}
.nav a:hover{background:rgba(212,184,150,0.08);color:#f0e6da}
.nav a.active{background:#f0fdf4;color:#059669}
.main{max-width:1200px;margin:0 auto;padding:2rem 1.5rem}
.page-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem}
.page-title{font-size:18px;font-weight:700;letter-spacing:-0.02em}
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
.btn-danger{background:#fee2e2;color:#b91c1c;border:1px solid #fca5a5}
.btn-danger:hover{background:#fecaca}
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

.form-group{margin-bottom:1.25rem}
.form-label{display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:.35rem}
.form-input{width:100%;padding:.5rem .75rem;border:1px solid #e5e7eb;border-radius:6px;font-size:14px;font-family:inherit;color:#0a0f0d;background:#fff}
.form-input:focus{outline:none;border-color:#059669;box-shadow:0 0 0 3px rgba(5,150,105,.1)}
.form-input:disabled{background:#f9fafb;color:#9ca3af;cursor:not-allowed}
.form-select{appearance:none;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right .75rem center;padding-right:2.5rem}
.form-hint{font-size:11px;color:#9ca3af;margin-top:.25rem}
.form-row{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:640px){.form-row{grid-template-columns:1fr}}
.alert{padding:.75rem 1rem;border-radius:8px;font-size:13px;margin-bottom:1.25rem}
.alert-error{background:#fee2e2;border:1px solid #fca5a5;color:#b91c1c}
.alert-success{background:#dcfce7;border:1px solid #86efac;color:#15803d}
.section-label{font-size:13px;font-weight:600;margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid #f3f4f6}
.hours-table{width:100%;border-collapse:collapse}
.hours-table th{font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;padding:.5rem .4rem;border-bottom:1px solid #f3f4f6;text-align:center}
.hours-table th:first-child{text-align:left}
.hours-table td{padding:.5rem .4rem;border-bottom:1px solid #f9fafb;vertical-align:middle}
.hours-table tr:last-child td{border-bottom:none}
.time-input{padding:.3rem .5rem;border:1px solid #e5e7eb;border-radius:5px;font-size:12px;font-family:inherit;width:90px}
.time-input:disabled{background:#f9fafb;color:#d1d5db;cursor:not-allowed}
.service-row{display:flex;gap:.5rem;align-items:center;margin-bottom:.5rem}
.form-actions{display:flex;gap:.75rem;margin-top:1.5rem;padding-top:1.25rem;border-top:1px solid #f3f4f6}
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
  <title>Emma Admin — ${esc(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>${CSS}</style>
</head>
<body>
  <div class="topbar">
    <span class="brand">Emma <span>Admin</span></span>
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

  const se = encodeURIComponent(secret)

  if (all.length === 0) {
    const body = `
      <div class="page-header">
        <h1 class="page-title">Negocios</h1>
        <a href="/admin/dashboard/new?secret=${se}" class="btn btn-primary">+ Nuevo negocio</a>
      </div>
      <div class="card"><div class="empty">No hay negocios registrados.<br>Crea el primero con el botón de arriba.</div></div>`
    return c.html(layout('Negocios', body, secret, 'businesses'))
  }

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
            <a href="/admin/dashboard/${esc(b.id)}/configure?secret=${se}" class="btn btn-ghost btn-sm">Configurar</a>
          </div>
        </td>
      </tr>`
    })
    .join('')

  const body = `
    <div class="page-header">
      <h1 class="page-title">Negocios <span style="font-weight:400;color:#9ca3af;font-size:14px">(${all.length})</span></h1>
      <a href="/admin/dashboard/new?secret=${se}" class="btn btn-primary">+ Nuevo negocio</a>
    </div>
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

  const anyTransitioning = all.some((b) => {
    const s = getConnectionState(b.id)?.status
    return s === 'connecting' || s === 'qr_pending'
  })

  return c.html(layout('Negocios', body, secret, 'businesses', anyTransitioning ? 10 : undefined))
})

// ── Vista 3: Sesiones WA ──────────────────────────────────────────────────────

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
    <h1 class="page-title" style="margin-bottom:1.5rem">Sesiones WhatsApp</h1>
    ${all.length === 0 ? '<div class="card"><div class="empty">No hay negocios registrados.</div></div>' : cards.join('')}`

  return c.html(
    layout('Sesiones WA', body, secret, 'sessions', hasTransitioning ? 8 : undefined),
  )
})

// ── Nuevo negocio: formulario ─────────────────────────────────────────────────

dashboardRoutes.get('/admin/dashboard/new', (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const se = encodeURIComponent(secret)
  const error = c.req.query('error') ? decodeURIComponent(c.req.query('error') ?? '') : null

  const body = `
    <a href="/admin/dashboard?secret=${se}" class="back">← Negocios</a>
    <h1 class="page-title">Nuevo negocio</h1>
    ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}
    <div class="card">
      <div class="card-header"><span class="card-title">Información del negocio</span></div>
      <div class="card-body">
        <form method="post" action="/admin/dashboard/new?secret=${se}">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="name">Nombre del negocio *</label>
              <input id="name" name="name" type="text" class="form-input"
                placeholder="ej. Imperio Barber Studio" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="timezone">Zona horaria</label>
              <select id="timezone" name="timezone" class="form-input form-select">
                <option value="America/Lima">América/Lima (Perú)</option>
                <option value="America/Bogota">América/Bogotá (Colombia)</option>
                <option value="America/Mexico_City">América/Ciudad de México</option>
                <option value="America/Santiago">América/Santiago (Chile)</option>
                <option value="America/Buenos_Aires">América/Buenos Aires</option>
                <option value="America/Guayaquil">América/Guayaquil (Ecuador)</option>
                <option value="America/Caracas">América/Caracas (Venezuela)</option>
                <option value="America/La_Paz">América/La Paz (Bolivia)</option>
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="whatsappNumber">Número WhatsApp del bot *</label>
              <input id="whatsappNumber" name="whatsappNumber" type="text" class="form-input"
                placeholder="51XXXXXXXXX (sin + ni espacios)" required>
              <p class="form-hint">Número que usará el bot para atender clientes</p>
            </div>
            <div class="form-group">
              <label class="form-label" for="ownerWhatsappNumber">WhatsApp del dueño</label>
              <input id="ownerWhatsappNumber" name="ownerWhatsappNumber" type="text"
                class="form-input" placeholder="51XXXXXXXXX (diferente al del bot)">
              <p class="form-hint">Número personal del dueño para recibir notificaciones</p>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="ownerName">Nombre del dueño</label>
            <input id="ownerName" name="ownerName" type="text" class="form-input"
              placeholder="ej. Carlos Ramos">
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Crear negocio</button>
            <a href="/admin/dashboard?secret=${se}" class="btn btn-ghost">Cancelar</a>
          </div>
        </form>
      </div>
    </div>`

  return c.html(layout('Nuevo negocio', body, secret, 'businesses'))
})

dashboardRoutes.post('/admin/dashboard/new', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const se = encodeURIComponent(secret)
  const formData = await c.req.formData()

  const name = formData.get('name')?.toString().trim() ?? ''
  const whatsappNumber = formData.get('whatsappNumber')?.toString().trim() ?? ''
  const ownerWhatsappNumber = formData.get('ownerWhatsappNumber')?.toString().trim() || null
  const ownerName = formData.get('ownerName')?.toString().trim() || null
  const timezone = formData.get('timezone')?.toString().trim() || 'America/Lima'

  if (!name || !whatsappNumber) {
    const errMsg = encodeURIComponent('Nombre y número WhatsApp son obligatorios.')
    return c.redirect(`/admin/dashboard/new?secret=${se}&error=${errMsg}`, 302)
  }

  const result = await businessService.register({ name, whatsappNumber, ownerWhatsappNumber, ownerName, timezone })
  if (!result.ok) {
    const errMsg = encodeURIComponent(result.error.message ?? 'Error al crear el negocio.')
    return c.redirect(`/admin/dashboard/new?secret=${se}&error=${errMsg}`, 302)
  }

  const newBusiness = result.data
  const bid = esc(newBusiness.id)

  // Start the WhatsApp session for the new business
  try {
    const { restartWhatsappFor } = await import('@/server.js')
    await restartWhatsappFor(newBusiness.id, newBusiness.whatsappNumber)
  } catch (err) {
    logger.error({ err, businessId: newBusiness.id }, 'dashboard: WA init after create failed')
  }

  const body = `
    <a href="/admin/dashboard?secret=${se}" class="back">← Negocios</a>
    <h1 class="page-title">Negocio creado</h1>
    <div class="alert alert-success">✓ <strong>${esc(newBusiness.name)}</strong> fue creado exitosamente.</div>
    <div class="card">
      <div class="card-body">
        <p style="margin-bottom:1.25rem;color:#374151;font-size:13px">
          El cliente de WhatsApp se está iniciando. Seguí estos pasos para poner el bot en marcha:
        </p>
        <div style="display:flex;gap:1rem;flex-wrap:wrap">
          <a href="/admin/dashboard/${bid}/configure?secret=${se}" class="btn btn-primary">
            1. Configurar horarios y servicios
          </a>
          <a href="/admin/whatsapp/pair?secret=${se}&businessId=${bid}" class="btn btn-warning">
            2. Vincular WhatsApp
          </a>
          <a href="/admin/dashboard/${bid}?secret=${se}" class="btn btn-ghost">
            Ver detalle
          </a>
        </div>
      </div>
    </div>`

  return c.html(layout('Negocio creado', body, secret, 'businesses'))
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
  const bid = esc(businessId)

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
    <div class="page-header">
      <h1 class="page-title">${esc(business.name)}</h1>
      <div class="actions">
        <a href="/admin/dashboard/${bid}/configure?secret=${se}" class="btn btn-primary">Configurar</a>
      </div>
    </div>

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
        <div class="stat-value" style="font-size:14px;margin-top:.4rem">${detail.googleConnectedEmail ? '<span class="badge badge-green">Conectado</span>' : '<span class="badge badge-gray">Sin conectar</span>'}</div>
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
            <a href="/admin/whatsapp/qr?secret=${se}&businessId=${bid}" class="btn btn-ghost btn-sm">Ver estado completo</a>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom:1.5rem">
      <div class="card-header">
        <span class="card-title">Google Calendar</span>
        ${detail.googleConnectedEmail
          ? '<span class="badge badge-green"><span class="dot dot-green"></span>Conectado</span>'
          : '<span class="badge badge-gray"><span class="dot dot-gray"></span>Sin conectar</span>'}
      </div>
      <div class="card-body">
        ${detail.googleConnectedEmail
          ? `<div class="info-row" style="margin-bottom:1rem">
               <span class="info-label">Cuenta</span>
               <span class="info-value">${esc(detail.googleConnectedEmail)}</span>
             </div>
             <div class="actions">
               <form method="post" action="/admin/dashboard/${bid}/google-disconnect?secret=${se}" style="display:inline"
                 onsubmit="return confirm('¿Desconectar Google Calendar? Las citas futuras no se crearán en el calendario.')">
                 <button type="submit" class="btn btn-danger btn-sm">Desconectar Calendar</button>
               </form>
               <a href="/auth/google/connect?businessId=${bid}" class="btn btn-ghost btn-sm">Reconectar / cambiar cuenta</a>
             </div>`
          : `<p style="font-size:13px;color:#6b7280;margin-bottom:1rem">
               Conectá Google Calendar para que las citas se registren automáticamente.
             </p>
             <a href="/auth/google/connect?businessId=${bid}" class="btn btn-primary btn-sm">Conectar Google Calendar</a>`}
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

// ── Configurar negocio: formulario ────────────────────────────────────────────

dashboardRoutes.get('/admin/dashboard/:id/configure', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const [business, gcEmail] = await Promise.all([
    businessRepo.findById(businessId),
    dashRepo.getGoogleConnectedEmail(businessId),
  ])
  if (!business) return c.html('<h1>404</h1>', 404) as Response

  const se = encodeURIComponent(secret)
  const bid = esc(businessId)
  const error = c.req.query('error') ? decodeURIComponent(c.req.query('error') ?? '') : null
  const saved = c.req.query('saved') === '1'

  const raw = business.settings as Partial<BusinessSettings>
  const hours = (raw?.operatingHours ?? {}) as Partial<Record<DayKey, DayHours>>

  const defaultHours: Record<DayKey, DayHours> = {
    monday: { open: '09:00', close: '18:00', break: { start: '13:00', end: '14:00' } },
    tuesday: { open: '09:00', close: '18:00', break: { start: '13:00', end: '14:00' } },
    wednesday: { open: '09:00', close: '18:00', break: { start: '13:00', end: '14:00' } },
    thursday: { open: '09:00', close: '18:00', break: { start: '13:00', end: '14:00' } },
    friday: { open: '09:00', close: '18:00', break: { start: '13:00', end: '14:00' } },
    saturday: { open: '09:00', close: '13:00' },
    sunday: null,
  }

  const effectiveHours = Object.fromEntries(
    DAYS.map(({ key }) => [key, key in hours ? (hours[key] ?? null) : defaultHours[key]]),
  ) as Record<DayKey, DayHours>

  const services = Array.isArray(raw?.services)
    ? (raw.services as Array<{ name: string; durationMinutes: number }>)
    : []

  const slotDuration = raw?.slotDurationMinutes ?? 30
  const minNotice = raw?.minBookingNoticeMinutes ?? 30
  const initialServiceCount = Math.max(services.length, 1)

  const hoursRows = DAYS.map(({ key, label }) =>
    renderDayRow(key, label, effectiveHours[key]),
  ).join('')

  const slotOptions = [15, 20, 30, 45, 60, 90, 120]
    .map((v) => `<option value="${v}" ${slotDuration === v ? 'selected' : ''}>${v} minutos</option>`)
    .join('')

  const body = `
    <a href="/admin/dashboard/${bid}?secret=${se}" class="back">← ${esc(business.name)}</a>
    <div class="page-header">
      <h1 class="page-title">Configurar — ${esc(business.name)}</h1>
    </div>
    ${saved ? '<div class="alert alert-success">✓ Cambios guardados correctamente.</div>' : ''}
    ${error ? `<div class="alert alert-error">${esc(error)}</div>` : ''}

    <form method="post" action="/admin/dashboard/${bid}/configure?secret=${se}">

      <div class="card" style="margin-bottom:1rem">
        <div class="card-header"><span class="card-title">Información del negocio</span></div>
        <div class="card-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="name">Nombre</label>
              <input id="name" name="name" type="text" class="form-input"
                value="${esc(business.name)}" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="timezone">Zona horaria</label>
              <select id="timezone" name="timezone" class="form-input form-select">
                ${[
                  ['America/Lima', 'América/Lima (Perú)'],
                  ['America/Bogota', 'América/Bogotá (Colombia)'],
                  ['America/Mexico_City', 'América/Ciudad de México'],
                  ['America/Santiago', 'América/Santiago (Chile)'],
                  ['America/Buenos_Aires', 'América/Buenos Aires'],
                  ['America/Guayaquil', 'América/Guayaquil (Ecuador)'],
                  ['America/Caracas', 'América/Caracas (Venezuela)'],
                  ['America/La_Paz', 'América/La Paz (Bolivia)'],
                ]
                  .map(([v, l]) => `<option value="${v}" ${business.timezone === v ? 'selected' : ''}>${l}</option>`)
                  .join('')}
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="ownerName">Nombre del dueño</label>
              <input id="ownerName" name="ownerName" type="text" class="form-input"
                value="${esc(business.ownerName ?? '')}" placeholder="ej. Carlos Ramos">
            </div>
            <div class="form-group">
              <label class="form-label" for="ownerWhatsappNumber">WhatsApp del dueño</label>
              <input id="ownerWhatsappNumber" name="ownerWhatsappNumber" type="text"
                class="form-input" value="${esc(business.ownerWhatsappNumber ?? '')}"
                placeholder="51XXXXXXXXX">
              <p class="form-hint">Diferente al número del bot</p>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:1rem">
        <div class="card-header"><span class="card-title">Horarios de atención</span></div>
        <div class="card-body">
          <div class="table-wrap">
            <table class="hours-table">
              <thead>
                <tr>
                  <th>Día</th>
                  <th>Abierto</th>
                  <th>Apertura</th>
                  <th>Cierre</th>
                  <th>Break</th>
                  <th>Inicio break</th>
                  <th>Fin break</th>
                </tr>
              </thead>
              <tbody>${hoursRows}</tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="card" style="margin-bottom:1rem">
        <div class="card-header"><span class="card-title">Servicios</span></div>
        <div class="card-body">
          <div style="display:flex;gap:.5rem;margin-bottom:.5rem">
            <span style="flex:1;font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em">Servicio</span>
            <span style="width:80px;font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em">Duración (min)</span>
            <span style="width:32px"></span>
          </div>
          <div id="services-container">
            ${renderServiceRows(services)}
          </div>
          <input type="hidden" name="service_count" id="service_count" value="${initialServiceCount}">
          <button type="button" class="btn btn-ghost btn-sm" style="margin-top:.5rem" onclick="addService()">
            + Agregar servicio
          </button>
        </div>
      </div>

      <div class="card" style="margin-bottom:1rem">
        <div class="card-header"><span class="card-title">Configuración de turnos</span></div>
        <div class="card-body">
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="slotDurationMinutes">Duración de cada turno</label>
              <select id="slotDurationMinutes" name="slotDurationMinutes" class="form-input form-select">
                ${slotOptions}
              </select>
              <p class="form-hint">Intervalo entre turnos disponibles en el calendario</p>
            </div>
            <div class="form-group">
              <label class="form-label" for="minBookingNoticeMinutes">Anticipación mínima (minutos)</label>
              <input id="minBookingNoticeMinutes" name="minBookingNoticeMinutes" type="number"
                class="form-input" min="0" max="1440" value="${minNotice}">
              <p class="form-hint">Mínimo tiempo entre "ahora" y el primer turno agendable (0 = sin restricción, default: 30)</p>
            </div>
          </div>
        </div>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Guardar cambios</button>
        <a href="/admin/dashboard/${bid}?secret=${se}" class="btn btn-ghost">Cancelar</a>
      </div>

    </form>

    <div class="card" style="margin-top:1rem">
      <div class="card-header">
        <span class="card-title">Google Calendar</span>
        ${gcEmail
          ? '<span class="badge badge-green"><span class="dot dot-green"></span>Conectado</span>'
          : '<span class="badge badge-gray"><span class="dot dot-gray"></span>Sin conectar</span>'}
      </div>
      <div class="card-body">
        ${gcEmail
          ? `<div class="info-row" style="margin-bottom:1rem">
               <span class="info-label">Cuenta</span>
               <span class="info-value">${esc(gcEmail)}</span>
             </div>
             <div class="actions">
               <form method="post" action="/admin/dashboard/${bid}/google-disconnect?secret=${se}" style="display:inline"
                 onsubmit="return confirm('¿Desconectar Google Calendar?')">
                 <button type="submit" class="btn btn-danger btn-sm">Desconectar Calendar</button>
               </form>
               <a href="/auth/google/connect?businessId=${bid}" class="btn btn-ghost btn-sm">Reconectar / cambiar cuenta</a>
             </div>`
          : `<p style="font-size:13px;color:#6b7280;margin-bottom:1rem">
               Conectá Google Calendar para que las citas se creen automáticamente.
             </p>
             <a href="/auth/google/connect?businessId=${bid}" class="btn btn-primary btn-sm">Conectar Google Calendar</a>`}
      </div>
    </div>

    <script>
    let _svcCounter = ${initialServiceCount};

    function toggleDay(day) {
      const enabled = document.getElementById('day_' + day + '_enabled').checked;
      ['open','close','break','break_start','break_end'].forEach(function(f) {
        const el = document.getElementById('day_' + day + '_' + f);
        if (el) el.disabled = !enabled;
      });
      if (!enabled) {
        const brk = document.getElementById('day_' + day + '_break');
        if (brk) brk.checked = false;
        ['break_start','break_end'].forEach(function(f) {
          const el = document.getElementById('day_' + day + '_' + f);
          if (el) el.disabled = true;
        });
      }
    }

    function toggleBreak(day) {
      const enabled = document.getElementById('day_' + day + '_break').checked;
      ['break_start','break_end'].forEach(function(f) {
        const el = document.getElementById('day_' + day + '_' + f);
        if (el) el.disabled = !enabled;
      });
    }

    function addService() {
      const idx = _svcCounter++;
      const row = document.createElement('div');
      row.className = 'service-row';
      row.id = 'service-row-' + idx;
      row.innerHTML =
        '<input type="text" class="form-input" name="service_' + idx + '_name" data-field="name"' +
        ' placeholder="ej. Corte de cabello" style="flex:1" required>' +
        '<input type="number" class="form-input" name="service_' + idx + '_duration" data-field="duration"' +
        ' min="5" max="480" value="30" placeholder="Min" style="width:80px">' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="removeService(this)">✕</button>';
      document.getElementById('services-container').appendChild(row);
      document.getElementById('service_count').value = _svcCounter;
    }

    function removeService(btn) {
      const row = btn.closest('.service-row');
      if (document.querySelectorAll('.service-row').length <= 1) {
        alert('El negocio debe tener al menos un servicio.');
        return;
      }
      row.remove();
      reindexServices();
    }

    function reindexServices() {
      const rows = document.querySelectorAll('.service-row');
      rows.forEach(function(row, i) {
        row.querySelector('[data-field="name"]').name = 'service_' + i + '_name';
        row.querySelector('[data-field="duration"]').name = 'service_' + i + '_duration';
      });
      _svcCounter = rows.length;
      document.getElementById('service_count').value = _svcCounter;
    }
    </script>`

  return c.html(layout(`Configurar — ${business.name}`, body, secret, 'businesses'))
})

dashboardRoutes.post('/admin/dashboard/:id/configure', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const se = encodeURIComponent(secret)
  const bid = esc(businessId)

  const business = await businessRepo.findById(businessId)
  if (!business) return c.html('<h1>404</h1>', 404) as Response

  const formData = await c.req.formData()

  // Update basic business info
  const name = formData.get('name')?.toString().trim() ?? ''
  const timezone = formData.get('timezone')?.toString().trim() ?? business.timezone
  const ownerName = formData.get('ownerName')?.toString().trim() || null
  const ownerWhatsappNumber = formData.get('ownerWhatsappNumber')?.toString().trim() || null

  if (name && name !== business.name) {
    await businessRepo.update(businessId, { name })
  }
  if (timezone !== business.timezone || ownerName !== business.ownerName || ownerWhatsappNumber !== business.ownerWhatsappNumber) {
    await businessRepo.update(businessId, { timezone, ownerName, ownerWhatsappNumber })
  }

  // Parse and validate settings
  const parsed = await parseSettingsFromForm(formData)
  if (!parsed.ok) {
    const errMsg = encodeURIComponent(parsed.errors.join(' | '))
    return c.redirect(`/admin/dashboard/${bid}/configure?secret=${se}&error=${errMsg}`, 302)
  }

  // Preserve existing botPaused state (managed by the bot, not by this form)
  const existingRaw = business.settings as Partial<BusinessSettings>
  const newSettings = {
    ...parsed.data,
    botPaused: existingRaw?.botPaused ?? null,
  }

  await businessRepo.update(businessId, { settings: newSettings as Record<string, unknown> })

  return c.redirect(`/admin/dashboard/${bid}/configure?secret=${se}&saved=1`, 302)
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

// ── POST /:id/google-disconnect — elimina credenciales de Google Calendar ────

dashboardRoutes.post('/admin/dashboard/:id/google-disconnect', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  await dashRepo.deleteGoogleCredential(businessId)
  logger.info({ businessId }, 'dashboard: Google Calendar disconnected by admin')

  return c.redirect(
    `/admin/dashboard/${esc(businessId)}?secret=${encodeURIComponent(secret)}`,
    302,
  )
})

// ── POST /:id/disconnect — borra sesión y marca como logged_out ───────────────

dashboardRoutes.post('/admin/dashboard/:id/disconnect', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const business = await businessRepo.findById(businessId)
  if (!business) return c.html('<h1>404 — Not found</h1>', 404) as Response

  const sessionDir = `${env.SESSIONS_DIR}/${businessId}`
  try {
    await rm(sessionDir, { recursive: true, force: true })
  } catch (err) {
    logger.error({ err, businessId, sessionDir }, 'dashboard: failed to delete session dir')
  }

  setConnectionStatus(businessId, 'logged_out')
  logger.info({ businessId }, 'dashboard: session disconnected by admin')

  return c.redirect(
    `/admin/dashboard/${esc(businessId)}?secret=${encodeURIComponent(secret)}`,
    302,
  )
})
