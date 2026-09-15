import { rm } from 'node:fs/promises'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { env } from '@/config/env.js'
import { logger } from '@/config/logger.js'
import * as appointmentRepo from '@/modules/appointment/appointment.repo.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import * as businessService from '@/modules/business/business.service.js'
import * as googleCalendarService from '@/modules/google/googleCalendar.service.js'
import * as knowledgeBaseService from '@/modules/knowledgeBase/knowledgeBase.service.js'
// Read-only on this surface now: the business detail page still summarises the
// knowledge base, but editing it lives in the owner's panel.
import { KB_CATEGORIES, KB_CATEGORY_LABELS } from '@/modules/knowledgeBase/knowledgeBase.types.js'
import {
  dayRangeInTimezone,
  shiftDateISO,
  todayInTimezone,
} from '@/modules/ownerAssistant/timezone.js'
import {
  getClient,
  getConnectionState,
  setConnectionStatus,
  unregisterClient,
} from '@/modules/whatsapp/clientRegistry.js'
import * as sessionGuard from '@/modules/whatsapp/sessionGuard.service.js'
import { SessionGuardError } from '@/shared/errors.js'
import { normalizePhone, samePhone } from '@/shared/phone.js'
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

// Spanish labels so the panel doesn't leak raw column values at the operator.
const APPT_STATUS_LABELS: Record<string, string> = {
  pending: 'Por aprobar',
  scheduled: 'Agendada',
  confirmed: 'Confirmada',
  cancelled: 'Cancelada',
  completed: 'Completada',
}

function apptStatusBadge(status: string): string {
  const cfg: Record<string, string> = {
    pending: 'badge-yellow',
    scheduled: 'badge-yellow',
    confirmed: 'badge-green',
    cancelled: 'badge-red',
    completed: 'badge-gray',
  }
  const label = APPT_STATUS_LABELS[status] ?? status
  return `<span class="badge ${cfg[status] ?? 'badge-gray'}">${esc(label)}</span>`
}

/** Formats a millisecond wait as "6h 12min" / "45 min" / "30 s" for operators. */
function humanizeMs(ms: number): string {
  const totalSecs = Math.ceil(ms / 1000)
  if (totalSecs < 60) return `${totalSecs} s`
  const hours = Math.floor(totalSecs / 3600)
  const mins = Math.ceil((totalSecs % 3600) / 60)
  return hours > 0 ? `${hours}h ${mins}min` : `${mins} min`
}

function waActions(businessId: string, status: WaStatus | undefined, secret: string): string {
  const se = encodeURIComponent(secret)
  const bid = esc(businessId)
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
    return `<a href="${qrUrl}" class="btn btn-primary btn-sm">Ver QR / Vincular</a>`
  }
  if (status === 'connecting') {
    return `<span class="badge badge-gray" style="font-size:11px">Iniciando…</span>`
  }
  const label = status === 'logged_out' ? 'Reconectar' : 'Conectar'
  // Confirmation is not cosmetic here: every click is a fresh pairing attempt
  // that WhatsApp counts against the number, and a double-click used to mean
  // two of them.
  const warn =
    status === 'logged_out'
      ? '¿Reintentar la vinculación? WhatsApp cerró esta sesión. Reintentar demasiadas veces puede banear el número de forma permanente.'
      : '¿Iniciar sesión de WhatsApp para este negocio? Cada intento cuenta contra el límite de WhatsApp.'
  return `<form method="post" action="${connectUrl}" style="display:inline"
    onsubmit="return confirm('${warn}')">
    <button type="submit" class="btn btn-warning btn-sm">${label}</button>
  </form>`
}

// ── Session guard warning ─────────────────────────────────────────────────────
//
// The anti-ban guard is keyed by phone NUMBER and its row deliberately outlives
// the business that used it. So a brand new business can inherit throttling from
// a number's previous life, which reads as a bug unless we say it out loud.

function hasResidualGuardState(status: sessionGuard.GuardStatus): boolean {
  return status.blocked || status.haltReason !== null || status.attemptCount > 0
}

function renderGuardWarning(
  status: sessionGuard.GuardStatus,
  businessId: string,
  whatsappNumber: string,
  secret: string,
): string {
  if (!hasResidualGuardState(status)) return ''

  const se = encodeURIComponent(secret)
  const bid = esc(businessId)
  const num = esc(whatsappNumber)

  const rows: string[] = []
  if (status.blocked) {
    rows.push(
      `<div class="info-row"><span class="info-label">Bloqueado hasta</span><span class="info-value">${fmtDatetime(status.blockedUntil)} — faltan ${esc(humanizeMs(status.retryAfterMs))}</span></div>`,
    )
  }
  if (status.haltReason) {
    rows.push(
      `<div class="info-row"><span class="info-label">Motivo</span><span class="info-value mono">${esc(status.haltReason)}</span></div>`,
    )
  }
  rows.push(
    `<div class="info-row"><span class="info-label">Intentos</span><span class="info-value">${status.attemptCount}</span></div>`,
  )

  const confirmMsg = `¿Limpiar el estado de vinculación del número ${whatsappNumber}?\\n\\nBorra el bloqueo y el contador de intentos. Hacelo SOLO si el historial viene de otro negocio y no de intentos reales recientes: saltear esta protección es lo que puede hacer que WhatsApp banee el número.`

  return `<div class="alert alert-error" style="display:block">
      <strong>⚠️ El número ${num} arrastra estado de vinculaciones anteriores</strong>
      <p style="margin-top:.5rem;font-size:13px">
        La protección anti-ban sigue al número, no al negocio. Si este número ya se usó antes
        (otro negocio, una prueba, un negocio borrado) hereda ese historial y puede bloquear
        la vinculación aunque el negocio sea nuevo.
      </p>
      <div style="margin:.75rem 0">${rows.join('')}</div>
      <form method="post" action="/admin/dashboard/${bid}/session/clear-guard?secret=${se}" style="display:inline"
        onsubmit="return confirm('${confirmMsg}')">
        <button type="submit" class="btn btn-danger btn-sm">Limpiar estado del número</button>
      </form>
    </div>`
}

// ── Configure panel helpers ───────────────────────────────────────────────────

// Alerts render as dismissible popups instead of full-width banners so the page
// keeps the same height whatever query params came back. Only the success toast
// auto-closes: the error one carries the validation detail the owner needs in
// order to fix the form, and the rebind one carries the QR link that brings
// Emma back online — neither may evaporate on its own.
/**
 * Where the rest of the configuration went.
 *
 * Every business gets a panel link, and this is the only place in the admin
 * that shows it — without it the operator has no way to reach the surface that
 * now owns hours, services, deposits and the knowledge base. A business created
 * before panel tokens existed has none, and says so rather than linking nowhere.
 */
function panelHandoffSection(
  business: { id: string; panelToken: string | null },
  secretParam: string,
): string {
  const bid = esc(business.id)
  if (!business.panelToken) {
    return `<section class="config-section">
        <div class="section-header">
          <h2 class="section-title">Panel del cliente</h2>
          <p class="section-desc">
            Este negocio no tiene token de panel. Se genera al registrarlo; para uno viejo hay que
            escribirlo a mano en <span class="mono">businesses.panel_token</span>.
          </p>
        </div>
      </section>`
  }

  const url = `/panel/${bid}?token=${encodeURIComponent(business.panelToken)}`
  return `<section class="config-section">
      <div class="section-header">
        <h2 class="section-title">Panel del cliente</h2>
        <p class="section-desc">
          Horarios, servicios, pagos, conocimiento del negocio y recordatorios se editan ahí.
          El link es la credencial: cualquiera que lo tenga entra.
        </p>
      </div>
      <div class="actions">
        <a href="${url}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">Abrir panel</a>
        <a href="/admin/dashboard/${bid}?secret=${secretParam}" class="btn btn-ghost btn-sm">Volver al negocio</a>
      </div>
    </section>`
}

function renderToast(
  kind: 'success' | 'error' | 'warning',
  title: string,
  bodyHtml: string,
  autoDismissMs?: number,
): string {
  const auto = autoDismissMs ? ` data-autoclose="${autoDismissMs}"` : ''
  return `<div class="toast toast-${kind}"${auto}>
      <div class="toast-body">
        <div class="toast-title">${esc(title)}</div>
        <div class="toast-text">${bodyHtml}</div>
      </div>
      <button type="button" class="toast-close" aria-label="Cerrar"
        onclick="this.closest('.toast').remove()">✕</button>
    </div>`
}

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#fafaf8;color:#0a0f0d;font-size:14px;line-height:1.6}
a{color:inherit;text-decoration:none}
.topbar{background:#0a0f0d;border-bottom:1px solid #1a2b24;padding:0 1.5rem;display:flex;align-items:center;gap:1.5rem;height:52px;position:sticky;top:0;z-index:10}
.brand{font-weight:700;font-size:15px;letter-spacing:-0.01em;color:#059669}
.brand span{color:#d4b896}
.brand:hover{opacity:.85}
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

.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;font-family:inherit;line-height:1.25;text-decoration:none;border:none;cursor:pointer;transition:all .15s ease;white-space:nowrap}
.btn-primary{background:#059669;color:#fff;padding:9px 18px}
.btn-primary:hover{background:#047857}
.btn-ghost{background:#fff;color:#1a1a1a;border:1px solid #e8e8e5;padding:8px 16px}
.btn-ghost:hover{background:#fafaf8;border-color:#d1d1cd}
.btn-warning{background:#fff;color:#b45309;border:1px solid #fcd34d;padding:8px 16px}
.btn-warning:hover{background:#fffbeb}
.btn-danger{background:#fff;color:#dc2626;border:1px solid #fca5a5;padding:8px 16px}
.btn-danger:hover{background:#fef2f2;border-color:#f87171}
.btn-sm{padding:6px 12px;font-size:12px}
.actions{display:flex;gap:.4rem;align-items:center;flex-wrap:wrap}

.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
@media(max-width:900px){.grid-2{grid-template-columns:1fr}}
.empty{padding:2rem;text-align:center;color:#9ca3af;font-size:13px}

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
.alert-warning{background:#fef3c7;border:1px solid #fcd34d;color:#b45309}
.section-label{font-size:13px;font-weight:600;margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid #f3f4f6}
.hours-table{width:100%;border-collapse:collapse}
.hours-table th{font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;padding:.5rem .4rem;border-bottom:1px solid #f3f4f6;text-align:center}
.hours-table th:first-child{text-align:left}
.hours-table td{padding:.5rem .4rem;border-bottom:1px solid #f9fafb;vertical-align:middle}
.hours-table tr:last-child td{border-bottom:none}
.time-input{padding:.3rem .5rem;border:1px solid #e5e7eb;border-radius:5px;font-size:12px;font-family:inherit;width:90px}
.time-input:disabled{background:#f9fafb;color:#d1d5db;cursor:not-allowed}
.service-row{display:flex;gap:.5rem;align-items:center;margin-bottom:.5rem;flex-wrap:wrap}
.service-eval{display:flex;align-items:center;gap:.35rem;font-size:12px;color:#6b7280;white-space:nowrap}
.service-eval input{margin:0}
.service-ref{flex-basis:100%;margin:-.15rem 0 .35rem}
.service-ref .form-input{font-size:13px}
.mode-options{display:flex;flex-direction:column;gap:.6rem}
.mode-option{display:flex;gap:.6rem;align-items:flex-start;padding:.75rem .9rem;border:1px solid #e5e7eb;border-radius:8px;cursor:pointer}
.mode-option:hover{background:#fafaf8}
.mode-option input{margin-top:.2rem;flex-shrink:0}
.mode-option-title{font-size:13px;font-weight:600;color:#0a0f0d}
.mode-option-desc{font-size:12px;color:#6b7280;margin-top:.1rem}
.form-actions{display:flex;gap:.75rem;margin-top:1.5rem;padding-top:1.25rem;border-top:1px solid #f3f4f6}

/* ── Configure panel ──────────────────────────────────────────────────────────
   Scoped under .config-page on purpose. The palette below is a half-tone off
   the one the older views use (--border #e8e8e5 vs #e5e7eb), so applying it
   globally would shift the business list, the KB screens and the new-business
   form too. Only the configure panel opts in. */
:root{
--bg:#fafaf8;--surface:#ffffff;--border:#e8e8e5;--border-hover:#d1d1cd;
--text-primary:#1a1a1a;--text-secondary:#666666;--text-tertiary:#999999;
--accent:#059669;--accent-hover:#047857;--accent-subtle:#f0fdf4;
--danger:#dc2626;--danger-bg:#fef2f2;--warning-bg:#fffbeb;--success-bg:#f0fdf4;
}

.toast-stack{position:fixed;top:68px;right:24px;z-index:50;display:flex;flex-direction:column;gap:8px;width:380px;max-width:calc(100vw - 32px)}
.toast{background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--border);border-radius:8px;padding:12px 14px;font-size:13px;color:var(--text-primary);display:flex;gap:10px;align-items:flex-start}
.toast-success{border-left-color:var(--accent);background:var(--success-bg)}
.toast-error{border-left-color:var(--danger);background:var(--danger-bg)}
.toast-warning{border-left-color:#b45309;background:var(--warning-bg)}
.toast-body{flex:1;min-width:0}
.toast-title{font-weight:600;margin-bottom:2px}
.toast-text{color:var(--text-secondary);overflow-wrap:anywhere}
.toast-close{background:none;border:none;cursor:pointer;color:var(--text-tertiary);font-size:13px;line-height:1;padding:2px 0 0;font-family:inherit;flex-shrink:0}
.toast-close:hover{color:var(--text-primary)}

.config-layout{display:grid;grid-template-columns:200px 1fr;gap:32px;align-items:start}
.config-nav{position:sticky;top:76px;display:flex;flex-direction:column;gap:2px}
.config-nav-item{display:block;padding:8px 12px;font-size:13px;font-weight:500;color:var(--text-secondary);border-left:2px solid transparent;border-radius:0 6px 6px 0}
.config-nav-item:hover{color:var(--text-primary)}
.config-nav-item.is-active{color:var(--accent);border-left-color:var(--accent);background:var(--accent-subtle)}
.config-col{min-width:0;display:flex;flex-direction:column;gap:32px}
.config-form{display:flex;flex-direction:column;gap:32px}

.config-section{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;scroll-margin-top:76px}
.section-header{margin-bottom:20px}
.section-title{font-size:16px;font-weight:600;color:var(--text-primary);letter-spacing:-0.01em}
.section-desc{font-size:13px;font-weight:400;color:var(--text-secondary);margin-top:2px}
.section-danger{border-color:#f2d5d5}
.section-danger .section-title{color:var(--danger)}
.subsection{margin-top:24px;padding-top:24px;border-top:1px solid var(--border)}
.subsection-title{font-size:13px;font-weight:600;color:var(--text-primary)}
.subsection-desc{font-size:12px;color:var(--text-tertiary);margin-top:2px;margin-bottom:12px}
.check-field{display:flex;gap:8px;align-items:flex-start;font-size:14px;font-weight:400;color:var(--text-primary);cursor:pointer}
.check-field input{margin-top:4px;flex-shrink:0}
.svc-head{display:flex;gap:8px;margin-bottom:8px}
.svc-head span{font-size:12px;font-weight:500;color:var(--text-secondary)}

.kb-group-title{font-size:13px;font-weight:600;color:var(--text-primary);margin-bottom:2px}
.kb-group-title.is-second{margin-top:24px}
.kb-check-row{display:flex;gap:10px;align-items:baseline;padding:10px 0;border-bottom:1px solid #f4f4f2}
.kb-check-row:last-child{border-bottom:none}
.kb-mark{width:14px;flex-shrink:0;text-align:center;font-size:13px}
.kb-mark-on{color:var(--accent)}
.kb-mark-off{color:var(--text-tertiary)}
.kb-check-name{font-size:14px;font-weight:500;color:var(--text-primary);width:190px;flex-shrink:0}
.kb-check-row.is-missing .kb-check-name{font-weight:400;color:var(--text-secondary)}
.kb-check-meta{font-size:13px;color:var(--text-secondary)}
.kb-check-row.is-missing .kb-check-meta{color:var(--text-tertiary)}

/* Knowledge base page */
.kb-page .kb-banner{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;font-size:13px;color:var(--text-secondary);margin-bottom:24px}
.kb-page .kb-banner a{color:var(--accent);font-weight:500}
.kb-filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
.kb-filter{padding:6px 14px;border-radius:6px;font-size:13px;font-weight:500;background:#fff;color:var(--text-secondary);border:1px solid var(--border);white-space:nowrap}
.kb-filter:hover{border-color:var(--border-hover);color:var(--text-primary)}
.kb-filter.is-active{background:var(--accent);color:#fff;border-color:var(--accent)}
.kb-group{margin-bottom:32px}
.kb-group-header{font-size:16px;font-weight:600;color:var(--text-primary);letter-spacing:-0.01em;margin-bottom:12px}
.kb-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px 20px;margin-bottom:8px;display:flex;gap:16px;align-items:flex-start}
.kb-card-main{flex:1;min-width:0}
.kb-card-title{font-size:14px;font-weight:600;color:var(--text-primary);display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.kb-card-preview{font-size:13px;color:var(--text-secondary);margin-top:6px;overflow-wrap:anywhere}
.kb-card-meta{font-size:12px;color:var(--text-tertiary);margin-top:8px}
.kb-card-actions{display:flex;gap:8px;flex-shrink:0}
.kb-tag{padding:4px 10px;background:#f5f5f4;color:var(--text-secondary);border-radius:4px;font-size:11px;font-weight:500;white-space:nowrap}
.kb-empty{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;font-size:13px;color:var(--text-secondary)}
.kb-chips{display:flex;gap:8px;flex-wrap:wrap}
.kb-chips.is-in{animation:kbChipsIn .15s ease}
@keyframes kbChipsIn{from{opacity:0;transform:translateY(-2px)}to{opacity:1;transform:none}}
.suggestion-chip{display:inline-flex;padding:6px 14px;background:#fff;border:1px solid var(--border);border-radius:6px;font-size:12px;font-weight:500;font-family:inherit;color:var(--text-secondary);cursor:pointer;transition:all .15s}
.suggestion-chip:hover{border-color:var(--accent);color:var(--accent);background:var(--accent-subtle)}
.suggestion-chip.selected{border-color:var(--accent);background:var(--accent-subtle);color:var(--accent)}
@media(prefers-reduced-motion:reduce){.kb-chips.is-in{animation:none}}
@media(max-width:640px){.kb-card{flex-direction:column}.kb-card-actions{width:100%}}

.save-bar{position:sticky;bottom:0;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 24px;display:flex;justify-content:flex-end;gap:8px;z-index:10}

.config-page .form-group{margin-bottom:20px}
.config-page .form-group:last-child{margin-bottom:0}
.config-page .form-label{font-size:13px;font-weight:500;color:var(--text-secondary);text-transform:none;margin-bottom:6px}
.config-page .form-input{border-color:var(--border);border-radius:6px;padding:8px 12px;font-size:14px;color:var(--text-primary)}
.config-page .form-input:hover:not(:disabled){border-color:var(--border-hover)}
.config-page .form-input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(5,150,105,.1)}
.config-page .form-hint{font-size:12px;color:var(--text-tertiary);margin-top:6px}
.config-page .form-row{gap:20px}
.config-page .hours-table th{font-size:12px;font-weight:500;color:var(--text-secondary);text-transform:none;letter-spacing:0;border-bottom-color:var(--border);padding:8px 4px}
.config-page .hours-table td{border-bottom-color:#f4f4f2;padding:8px 4px}
.config-page .hours-table tr:hover td{background:transparent}
.config-page .time-input{border-color:var(--border);border-radius:6px}
.config-page .mode-option{border-color:var(--border);border-radius:8px}
.config-page .mode-option:hover{border-color:var(--border-hover);background:transparent}
.config-page .mode-option-title{color:var(--text-primary)}
.config-page .mode-option-desc{color:var(--text-secondary)}

@media(max-width:768px){
.toast-stack{top:60px;right:16px;left:16px;width:auto}
.config-layout{grid-template-columns:1fr;gap:16px}
.config-nav{position:sticky;top:52px;flex-direction:row;overflow-x:auto;gap:4px;background:var(--bg);border-bottom:1px solid var(--border);margin:0 -1.5rem;padding:8px 1.5rem;z-index:9;scrollbar-width:none}
.config-nav::-webkit-scrollbar{display:none}
.config-nav-item{white-space:nowrap;border-left:none;border-bottom:2px solid transparent;border-radius:6px 6px 0 0}
.config-nav-item.is-active{border-left-color:transparent;border-bottom-color:var(--accent)}
.config-section{padding:20px;scroll-margin-top:112px}
}
`

// ── Layout ────────────────────────────────────────────────────────────────────

function layout(title: string, body: string, secret: string, refreshSecs?: number): string {
  const s = encodeURIComponent(secret)
  const refresh = refreshSecs ? `<meta http-equiv="refresh" content="${refreshSecs}">` : ''

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
    <a href="/admin/dashboard?secret=${s}" class="brand">Emma <span>Admin</span></a>
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
    return c.html(layout('Negocios', body, secret))
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
            <a href="/admin/dashboard/${esc(b.id)}/configure?secret=${se}" class="btn btn-ghost btn-sm">Conexión</a>
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

  return c.html(layout('Negocios', body, secret, anyTransitioning ? 10 : undefined))
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
                placeholder="+51987654321" required>
              <p class="form-hint">Número que usará el bot para atender clientes</p>
            </div>
            <div class="form-group">
              <label class="form-label" for="ownerWhatsappNumber">WhatsApp del dueño</label>
              <input id="ownerWhatsappNumber" name="ownerWhatsappNumber" type="text"
                class="form-input" placeholder="+51987654321 (diferente al del bot)">
              <p class="form-hint">Número personal del dueño para recibir notificaciones</p>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="ownerName">Nombre del dueño</label>
            <input id="ownerName" name="ownerName" type="text" class="form-input"
              placeholder="ej. Carlos Ramos">
          </div>
          <div class="form-group">
            <label class="form-label" for="address">Dirección del negocio</label>
            <input id="address" name="address" type="text" class="form-input"
              placeholder="ej. Av. Ejército 820, Yanahuara, Arequipa">
            <p class="form-hint">Emma la responde cuando preguntan dónde están</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="googleMapsUrl">Link de Google Maps</label>
            <input id="googleMapsUrl" name="googleMapsUrl" type="url" class="form-input"
              placeholder="https://maps.app.goo.gl/...">
            <p class="form-hint">Complementario a la dirección</p>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Crear negocio</button>
            <a href="/admin/dashboard?secret=${se}" class="btn btn-ghost">Cancelar</a>
          </div>
        </form>
      </div>
    </div>`

  return c.html(layout('Nuevo negocio', body, secret))
})

dashboardRoutes.post('/admin/dashboard/new', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const se = encodeURIComponent(secret)
  const formData = await c.req.formData()

  const name = formData.get('name')?.toString().trim() ?? ''
  const whatsappNumber = formData.get('whatsappNumber')?.toString().trim() ?? ''
  // Stored normalized so the routing comparison in whatsapp/handler has a
  // canonical value to match against, whatever shape the operator typed.
  const ownerWhatsappNumber = normalizePhone(formData.get('ownerWhatsappNumber')?.toString())
  const ownerName = formData.get('ownerName')?.toString().trim() || null
  const timezone = formData.get('timezone')?.toString().trim() || 'America/Lima'
  const address = formData.get('address')?.toString().trim() || null
  const googleMapsUrl = formData.get('googleMapsUrl')?.toString().trim() || null

  if (!name || !whatsappNumber) {
    const errMsg = encodeURIComponent('Nombre y número WhatsApp son obligatorios.')
    return c.redirect(`/admin/dashboard/new?secret=${se}&error=${errMsg}`, 302)
  }

  // The API enforces this on its own path; the form used to let it through, and
  // an owner sharing the bot's number never reaches the owner assistant at all
  // (their messages come back as fromMe).
  if (samePhone(ownerWhatsappNumber, whatsappNumber)) {
    const errMsg = encodeURIComponent(
      'El WhatsApp del dueño debe ser distinto al número del bot. Usá un número personal aparte.',
    )
    return c.redirect(`/admin/dashboard/new?secret=${se}&error=${errMsg}`, 302)
  }

  const result = await businessService.register({
    name,
    whatsappNumber,
    ownerWhatsappNumber,
    ownerName,
    timezone,
    address,
    googleMapsUrl,
  })
  if (!result.ok) {
    const errMsg = encodeURIComponent(result.error.message ?? 'Error al crear el negocio.')
    return c.redirect(`/admin/dashboard/new?secret=${se}&error=${errMsg}`, 302)
  }

  const newBusiness = result.data
  const bid = esc(newBusiness.id)

  // Creating a business deliberately does NOT touch WhatsApp. Booting a socket
  // here also spent an attempt against the number (restartWhatsappFor records
  // one), which left the guard at attemptCount=1 before the operator had done
  // anything — and made the very first real linking attempt look like hammering.
  // Linking is now a separate, explicit click.
  const guardStatus = await sessionGuard.getStatus(newBusiness.whatsappNumber)

  const body = `
    <a href="/admin/dashboard?secret=${se}" class="back">← Negocios</a>
    <h1 class="page-title">Negocio creado</h1>
    <div class="alert alert-success">✓ <strong>${esc(newBusiness.name)}</strong> fue creado exitosamente.</div>
    ${renderGuardWarning(guardStatus, newBusiness.id, newBusiness.whatsappNumber, secret)}
    <div class="card">
      <div class="card-body">
        <p style="margin-bottom:.5rem;color:#374151;font-size:13px">
          El negocio quedó creado, pero <strong>WhatsApp todavía no está vinculado</strong>:
          Emma no va a responder hasta que lo vincules.
        </p>
        <p style="margin-bottom:1.25rem;color:#6b7280;font-size:13px">
          Vinculá recién cuando tengas el teléfono en la mano — cada intento cuenta
          contra el límite de WhatsApp para ese número.
        </p>
        <div style="display:flex;gap:1rem;flex-wrap:wrap;align-items:center">
          <a href="/admin/dashboard/${bid}/configure?secret=${se}" class="btn btn-primary">
            1. Revisar números y abrir el panel
          </a>
          <form method="post" action="/admin/dashboard/${bid}/connect?secret=${se}" style="display:inline"
            onsubmit="return confirm('¿Iniciar la vinculación de WhatsApp?\\n\\nSe va a generar un QR para escanear con el teléfono. Cada intento cuenta contra el límite de WhatsApp para este número.')">
            <button type="submit" class="btn btn-warning">2. Vincular WhatsApp (QR)</button>
          </form>
          <a href="/admin/dashboard/${bid}?secret=${se}" class="btn btn-ghost">
            Ver detalle
          </a>
        </div>
      </div>
    </div>`

  return c.html(layout('Negocio creado', body, secret))
})

// ── Vista 2: Detalle de negocio ───────────────────────────────────────────────

dashboardRoutes.get('/admin/dashboard/:id', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const [business, detail, kbResult] = await Promise.all([
    businessRepo.findById(businessId),
    dashRepo.getBusinessDetail(businessId),
    knowledgeBaseService.getByBusiness(businessId),
  ])

  if (!business) {
    return c.html(
      layout('No encontrado', '<p class="muted">Negocio no encontrado.</p>', secret),
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

  // A failed KB read must not take the whole detail page down — the section
  // renders its own error state and the rest of the page stays useful.
  const kbEntries = kbResult.ok ? kbResult.data : []
  const kbActive = kbEntries.filter((e) => e.active)
  const kbByCategory = KB_CATEGORIES.map((cat) => ({
    cat,
    count: kbActive.filter((e) => e.category === cat).length,
  })).filter((g) => g.count > 0)

  const kbSummary = !kbResult.ok
    ? '<p class="muted">No pudimos cargar la base de conocimiento.</p>'
    : kbEntries.length === 0
      ? '<p class="muted">Sin entradas todavía. Emma solo sabe lo que esté en la configuración.</p>'
      : `<div class="info-row">
           <span class="info-label">Entradas activas</span>
           <span class="info-value">${kbActive.length} de ${kbEntries.length}</span>
         </div>
         <div class="info-row">
           <span class="info-label">Categorías</span>
           <span class="info-value">${kbByCategory.map((g) => `${esc(KB_CATEGORY_LABELS[g.cat])} (${g.count})`).join(', ')}</span>
         </div>`

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
        <a href="/admin/dashboard/${bid}/configure?secret=${se}" class="btn btn-primary">Conexión</a>
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
          <div class="info-row"><span class="info-label">Dirección</span><span class="info-value">${business.address ? esc(business.address) : '<span class="muted">Sin configurar</span>'}</span></div>
          <div class="info-row"><span class="info-label">Google Maps</span><span class="info-value">${business.googleMapsUrl ? `<a href="${esc(business.googleMapsUrl)}" target="_blank" rel="noopener">${esc(business.googleMapsUrl)}</a>` : '<span class="muted">Sin configurar</span>'}</span></div>
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
        ${
          detail.googleConnectedEmail
            ? '<span class="badge badge-green"><span class="dot dot-green"></span>Conectado</span>'
            : '<span class="badge badge-gray"><span class="dot dot-gray"></span>Sin conectar</span>'
        }
      </div>
      <div class="card-body">
        ${
          detail.googleConnectedEmail
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
             <a href="/auth/google/connect?businessId=${bid}" class="btn btn-primary btn-sm">Conectar Google Calendar</a>`
        }
      </div>
    </div>

    <div class="card" style="margin-bottom:1.5rem">
      <div class="card-header">
        <span class="card-title">Base de conocimiento</span>
        <span class="muted" style="font-size:12px">Se edita desde el panel del cliente</span>
      </div>
      <div class="card-body">
        ${kbSummary}
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
        <div class="card-header">
          <span class="card-title">Últimas citas</span>
          <a href="/admin/dashboard/${bid}/appointments?secret=${se}" class="btn btn-ghost btn-sm">Ver todas / gestionar</a>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Fecha</th><th>Servicio</th><th>Cliente</th><th>Estado</th></tr></thead>
            <tbody>${apptRows}</tbody>
          </table>
        </div>
      </div>
    </div>`

  return c.html(layout(business.name, body, secret))
})

// ── Vista: Citas por día (listar + cancelar) ──────────────────────────────────

function apptTimeLabel(d: Date, timezone: string): string {
  return esc(
    d.toLocaleString('es-PE', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: timezone,
    }),
  )
}

dashboardRoutes.get('/admin/dashboard/:id/appointments', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const business = await businessRepo.findById(businessId)
  if (!business) return c.html('<h1>404</h1>', 404) as Response

  const se = encodeURIComponent(secret)
  const bid = esc(businessId)
  const canceled = c.req.query('cancelled') === '1'

  const dateISO = c.req.query('date') || todayInTimezone(business.timezone)
  const range = dayRangeInTimezone(dateISO, business.timezone)
  if (!range) {
    return c.html(layout('Fecha inválida', '<p class="muted">Fecha inválida.</p>', secret), 400)
  }

  const items = await appointmentRepo.listScheduledInRange(businessId, range.start, range.end, 200)

  const prevDate = shiftDateISO(dateISO, -1)
  const nextDate = shiftDateISO(dateISO, 1)
  const todayISO = todayInTimezone(business.timezone)

  const rows =
    items.length === 0
      ? '<tr><td colspan="5" class="empty">Sin citas para este día</td></tr>'
      : items
          .map((a) => {
            const canCancel = a.status === 'scheduled' || a.status === 'confirmed'
            const cancelUrl = `/admin/dashboard/${bid}/appointments/${esc(a.id)}/cancel?secret=${se}&date=${dateISO}`
            return `<tr>
              <td>${apptTimeLabel(a.scheduledAt, business.timezone)}</td>
              <td>${esc(a.service)}</td>
              <td>${esc(a.customerName ?? '—')}</td>
              <td><span class="mono muted">${esc(a.customerPhone)}</span></td>
              <td>${apptStatusBadge(a.status)}</td>
              <td>
                ${
                  canCancel
                    ? `<form method="post" action="${cancelUrl}" style="display:inline"
                       onsubmit="return confirm('¿Cancelar esta cita? Se le puede avisar al cliente por separado.')">
                       <button type="submit" class="btn btn-danger btn-sm">Cancelar</button>
                     </form>`
                    : '<span class="muted">—</span>'
                }
              </td>
            </tr>`
          })
          .join('')

  const body = `
    <a href="/admin/dashboard/${bid}?secret=${se}" class="back">← ${esc(business.name)}</a>
    <div class="page-header">
      <h1 class="page-title">Citas — ${esc(business.name)}</h1>
    </div>
    ${canceled ? '<div class="alert alert-success">✓ Cita cancelada.</div>' : ''}
    <div class="card" style="margin-bottom:1rem">
      <div class="card-body" style="display:flex;gap:.75rem;align-items:center;flex-wrap:wrap">
        <a href="?secret=${se}&date=${prevDate}" class="btn btn-ghost btn-sm">← Día anterior</a>
        <form method="get" action="/admin/dashboard/${bid}/appointments" style="display:inline-flex;gap:.5rem;align-items:center">
          <input type="hidden" name="secret" value="${esc(secret)}">
          <input type="date" name="date" class="form-input" value="${dateISO}" style="width:auto" onchange="this.form.submit()">
        </form>
        <a href="?secret=${se}&date=${nextDate}" class="btn btn-ghost btn-sm">Día siguiente →</a>
        ${dateISO !== todayISO ? `<a href="?secret=${se}&date=${todayISO}" class="btn btn-ghost btn-sm">Hoy</a>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Hora</th><th>Servicio</th><th>Cliente</th><th>Teléfono</th><th>Estado</th><th>Acciones</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`

  return c.html(layout(`Citas — ${business.name}`, body, secret))
})

dashboardRoutes.post('/admin/dashboard/:id/appointments/:apptId/cancel', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const apptId = c.req.param('apptId')
  const se = encodeURIComponent(secret)
  const dateISO = c.req.query('date')
  const suffix = dateISO ? `&date=${encodeURIComponent(dateISO)}` : ''

  const appt = await appointmentRepo.findById(businessId, apptId)
  if (!appt) return c.html('<h1>404</h1>', 404) as Response

  const updated = await appointmentRepo.update(businessId, apptId, { status: 'cancelled' })

  // Best-effort Google Calendar sync, same pattern as bookAppointment: the
  // local cancellation always sticks even if Calendar sync fails.
  if (updated.googleEventId) {
    const cancelResult = await googleCalendarService.cancelEvent(businessId, updated.googleEventId)
    if (!cancelResult.ok) {
      logger.warn(
        { businessId, apptId, code: cancelResult.error.code },
        'dashboard: appointment cancelled locally but Google Calendar sync failed',
      )
    }
  }

  logger.info({ businessId, apptId }, 'dashboard: appointment cancelled by admin')

  return c.redirect(
    `/admin/dashboard/${encodeURIComponent(businessId)}/appointments?secret=${se}&cancelled=1${suffix}`,
    302,
  )
})

// ── Configurar negocio: conexión y números ────────────────────────────────────
//
// Lo que quedó acá después de la migración al panel del cliente.
//
// Everything this form used to hold — hours, services, booking rules, deposits,
// the knowledge base, the niche — now lives in the owner's panel, which merges
// per section instead of rebuilding the whole settings document from a form.
// Keeping a second editor for the same jsonb meant two shapes of the same truth
// and a save here silently reverting what the owner had just set there.
//
// What the panel deliberately cannot touch stays: the bot's own WhatsApp number
// and the owner's, because changing the first one tears down the live session
// and needs a QR rescan — behind a token in a URL that is a mis-click away from
// taking a business off WhatsApp.

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
  const rebind = c.req.query('rebind')

  const toasts = [
    saved
      ? renderToast('success', 'Cambios guardados', 'Los datos quedaron actualizados.', 4000)
      : '',
    error ? renderToast('error', 'No se pudo guardar', esc(error)) : '',
    rebind === 'pending'
      ? renderToast(
          'warning',
          'Falta vincular el número nuevo',
          `Emma se desconectó del número anterior. Escaneá el QR con el teléfono de
           <strong>${esc(business.whatsappNumber)}</strong> para reactivarla.
           <div style="margin-top:10px">
             <a href="/admin/whatsapp/qr?secret=${se}&businessId=${bid}" class="btn btn-primary btn-sm">Ver QR</a>
           </div>
           <div style="margin-top:10px;color:var(--text-tertiary);font-size:12px">
             Acordate de desvincular Emma del teléfono anterior desde
             WhatsApp → Dispositivos vinculados.
           </div>`,
        )
      : '',
  ].join('')

  const body = `
    <div class="config-page">
    <a href="/admin/dashboard/${bid}?secret=${se}" class="back">← ${esc(business.name)}</a>
    <div class="page-header">
      <h1 class="page-title">Conexión — ${esc(business.name)}</h1>
    </div>
    <div class="toast-stack" role="status" aria-live="polite">${toasts}</div>

    <div class="config-layout">
      <nav class="config-nav">
        <a class="config-nav-item is-active" data-section="seccion-numeros" href="#seccion-numeros">Números</a>
        <a class="config-nav-item" data-section="seccion-google" href="#seccion-google">Google Calendar</a>
        <a class="config-nav-item" data-section="seccion-peligro" href="#seccion-peligro">Zona de peligro</a>
      </nav>

      <div class="config-col">

      ${panelHandoffSection(business, se)}

      <form id="config-form" class="config-form" method="post"
        action="/admin/dashboard/${bid}/configure?secret=${se}"
        onsubmit="return confirmNumberChange()">

        <section id="seccion-numeros" class="config-section">
          <div class="section-header">
            <h2 class="section-title">Números</h2>
            <p class="section-desc">
              El número por el que responde Emma y el del dueño, que la usa como asistente.
              Todo lo demás se configura desde el panel del cliente.
            </p>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="whatsappNumber">Número de WhatsApp del bot</label>
              <input type="text" id="whatsappNumber" name="whatsappNumber" class="form-input mono"
                value="${esc(business.whatsappNumber)}" data-original="${esc(business.whatsappNumber)}">
              <p class="form-hint">
                Cambiarlo desconecta la sesión actual: hay que escanear un QR nuevo con el teléfono del número nuevo.
              </p>
            </div>

            <div class="form-group">
              <label class="form-label" for="ownerWhatsappNumber">WhatsApp del dueño</label>
              <input type="text" id="ownerWhatsappNumber" name="ownerWhatsappNumber" class="form-input mono"
                value="${esc(business.ownerWhatsappNumber ?? '')}" placeholder="+51...">
              <p class="form-hint">
                Desde este número el dueño le habla a Emma como asistente. Tiene que ser distinto al del bot.
              </p>
            </div>
          </div>
        </section>
      </form>

      <section id="seccion-google" class="config-section">
        <div class="section-header">
          <h2 class="section-title">Google Calendar</h2>
          <p class="section-desc">
            ${
              gcEmail
                ? `Conectado a ${esc(gcEmail)} — las citas se crean automáticamente.`
                : 'Sin conectar. Las citas se guardan igual, pero no aparecen en el calendario.'
            }
          </p>
        </div>
        ${
          gcEmail
            ? `<div class="actions">
               <form method="post" action="/admin/dashboard/${bid}/google-disconnect?secret=${se}" style="display:inline"
                 onsubmit="return confirm('¿Desconectar Google Calendar?')">
                 <button type="submit" class="btn btn-danger btn-sm">Desconectar Calendar</button>
               </form>
               <a href="/auth/google/connect?businessId=${bid}" class="btn btn-ghost btn-sm">Reconectar / cambiar cuenta</a>
             </div>`
            : `<a href="/auth/google/connect?businessId=${bid}" class="btn btn-primary btn-sm">Conectar Google Calendar</a>`
        }
      </section>

      <section id="seccion-peligro" class="config-section section-danger">
        <div class="section-header">
          <h2 class="section-title">Zona de peligro</h2>
          <p class="section-desc">
            Desvincular WhatsApp saca a Emma del número
            <span class="mono">${esc(business.whatsappNumber)}</span> y deja de responder de inmediato.
          </p>
        </div>
        <p class="section-desc" style="margin-bottom:20px">
          Cierra la sesión contra WhatsApp, quita el dispositivo de la lista del teléfono del cliente
          y borra las credenciales guardadas. Para volver a usar este número hay que escanear un QR nuevo.
        </p>
        <form method="post" action="/admin/dashboard/${bid}/disconnect?secret=${se}" style="display:inline"
          onsubmit="return confirm('¿Desvincular WhatsApp de ${esc(business.whatsappNumber)}?\\n\\nEmma deja de responder ya mismo y el dispositivo se quita del teléfono del cliente.\\n\\nEsto NO se puede deshacer: para volver hay que escanear un QR nuevo.')">
          <input type="hidden" name="from" value="configure">
          <button type="submit" class="btn btn-danger btn-sm">Desvincular WhatsApp</button>
        </form>
      </section>

      <div class="save-bar">
        <a href="/admin/dashboard/${bid}?secret=${se}" class="btn btn-ghost">Cancelar</a>
        <button type="submit" form="config-form" class="btn btn-primary">Guardar cambios</button>
      </div>

      </div>
    </div>

    <script>
    function confirmNumberChange() {
      const el = document.getElementById('whatsappNumber');
      if (!el) return true;
      const current = el.value.trim();
      const original = el.getAttribute('data-original');
      if (current === original) return true;
      return confirm(
        'Vas a cambiar el número del bot de ' + original + ' a ' + current + '.\\n\\n' +
        'Emma se va a desconectar del número anterior y vas a tener que escanear un QR nuevo ' +
        'con el teléfono del número nuevo.\\n\\n' +
        'Las citas, conversaciones e historial NO se borran.\\n\\n¿Continuar?'
      );
    }

    (function() {
      var items = Array.prototype.slice.call(document.querySelectorAll('.config-nav-item'));
      var sections = items
        .map(function(it) { return document.getElementById(it.getAttribute('data-section')) })
        .filter(Boolean);
      if (!sections.length) return;

      var visible = {};
      var obs = new IntersectionObserver(function(entries) {
        entries.forEach(function(e) { visible[e.target.id] = e.isIntersecting });
        var topId = null;
        for (var i = 0; i < sections.length; i++) {
          if (visible[sections[i].id]) { topId = sections[i].id; break }
        }
        if (!topId) return;
        items.forEach(function(it) {
          it.classList.toggle('is-active', it.getAttribute('data-section') === topId);
        });
      }, { rootMargin: '-80px 0px -55% 0px', threshold: 0 });

      sections.forEach(function(s) { obs.observe(s) });
    })();
    </script>
    </div>`

  return c.html(layout(`Conexión — ${business.name}`, body, secret))
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

  // Stored normalized so the routing comparison in whatsapp/handler has a
  // canonical value to match against, whatever shape the operator typed.
  const ownerWhatsappNumber = normalizePhone(formData.get('ownerWhatsappNumber')?.toString())
  const whatsappNumber =
    formData.get('whatsappNumber')?.toString().trim() || business.whatsappNumber

  const configureError = (msg: string) =>
    c.redirect(
      `/admin/dashboard/${bid}/configure?secret=${se}&error=${encodeURIComponent(msg)}`,
      302,
    )

  // The bot number is logged in as `whatsappNumber`, so messages from it are
  // treated as fromMe and would never reach the owner assistant.
  // samePhone, not `===`: "51999..." and "+51999..." are the same line, and
  // letting that pass would log the bot in as its own owner.
  if (samePhone(ownerWhatsappNumber, whatsappNumber)) {
    return configureError(
      'El WhatsApp del dueño debe ser distinto al número del bot. Usá un número personal aparte.',
    )
  }

  const numberChanged = whatsappNumber !== business.whatsappNumber
  if (numberChanged) {
    const takenBy = await businessRepo.findByWhatsappNumber(whatsappNumber)
    if (takenBy && takenBy.id !== businessId) {
      return configureError(`El número ${whatsappNumber} ya está en uso por "${takenBy.name}".`)
    }
  }

  if (ownerWhatsappNumber !== business.ownerWhatsappNumber) {
    await businessRepo.update(businessId, { ownerWhatsappNumber })
  }

  if (!numberChanged) {
    return c.redirect(`/admin/dashboard/${bid}/configure?secret=${se}&saved=1`, 302)
  }

  try {
    await businessRepo.update(businessId, { whatsappNumber })
  } catch (err) {
    logger.error({ err, businessId, whatsappNumber }, 'dashboard: whatsapp number update failed')
    return configureError('No se pudo guardar el número nuevo.')
  }

  // The DB now points at the new number but the live socket is still logged in
  // as the old one, so rebind it. Best-effort: the number change is already
  // committed, and the operator can retry from the "Conectar" button.
  let rebindError: string | null = null
  try {
    const { restartWhatsappFor } = await import('@/server.js')
    await restartWhatsappFor(businessId, whatsappNumber)
  } catch (err) {
    rebindError =
      err instanceof SessionGuardError
        ? `${err.userMessage} Reintentá en ${humanizeMs(err.retryAfterMs)}.`
        : 'No se pudo iniciar la sesión con el número nuevo. Usá el botón "Conectar".'
    logger.error(
      { err, businessId, whatsappNumber },
      'dashboard: rebind after number change failed',
    )
  }

  const params = rebindError
    ? `saved=1&rebind=failed&error=${encodeURIComponent(rebindError)}`
    : 'saved=1&rebind=pending'
  return c.redirect(`/admin/dashboard/${bid}/configure?secret=${se}&${params}`, 302)
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
    if (err instanceof SessionGuardError) {
      logger.warn(
        { businessId, retryAfterMs: err.retryAfterMs, reason: err.reason },
        'dashboard: connect blocked by session guard',
      )
      return c.html(
        layout(
          'Vinculación bloqueada',
          `<a href="/admin/dashboard/${esc(businessId)}?secret=${encodeURIComponent(secret)}" class="back">← Volver</a>
           <div class="alert alert-error" style="margin-top:1rem">
             🛑 ${esc(err.userMessage)}<br>
             <strong>Podés reintentar en ${esc(humanizeMs(err.retryAfterMs))}.</strong>
           </div>`,
          secret,
        ),
        429,
      )
    }
    logger.error({ err, businessId }, 'dashboard: connect failed')
    return c.html(
      layout(
        'Error al conectar',
        `<a href="/admin/dashboard?secret=${encodeURIComponent(secret)}" class="back">← Negocios</a>
         <p style="color:#b91c1c;margin-top:1rem">No se pudo iniciar la sesión: ${esc((err as Error).message ?? 'error desconocido')}</p>`,
        secret,
      ),
      500,
    )
  }

  const se = encodeURIComponent(secret)
  return c.redirect(
    `/admin/whatsapp/qr?secret=${se}&businessId=${encodeURIComponent(businessId)}`,
    302,
  )
})

// ── POST /:id/google-disconnect — elimina credenciales de Google Calendar ────

dashboardRoutes.post('/admin/dashboard/:id/google-disconnect', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  await dashRepo.deleteGoogleCredential(businessId)
  logger.info({ businessId }, 'dashboard: Google Calendar disconnected by admin')

  return c.redirect(`/admin/dashboard/${esc(businessId)}?secret=${encodeURIComponent(secret)}`, 302)
})

// ── POST /:id/session/clear-guard — limpia el estado anti-ban del número ──────
//
// Separate from disconnect on purpose. Disconnect is offboarding (Emma leaves a
// customer's number); this is the narrow escape hatch for a NEW business stuck
// behind a previous tenant's throttling on a reused number. Keeping them apart
// means "Desconectar" never doubles as a one-click bypass of the ban protection.

dashboardRoutes.post('/admin/dashboard/:id/session/clear-guard', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const business = await businessRepo.findById(businessId)
  if (!business) return c.html('<h1>404 — Not found</h1>', 404) as Response

  // forceUnblock logs a loud warn with everything it cleared.
  await sessionGuard.forceUnblock(business.whatsappNumber, business.id)

  return c.redirect(
    `/admin/dashboard/${encodeURIComponent(businessId)}?secret=${encodeURIComponent(secret)}`,
    302,
  )
})

// ── POST /:id/disconnect — Emma se va del número del cliente ──────────────────
//
// Offboarding: the customer stopped paying or is leaving, and Emma has to get
// out of their WhatsApp. That means three things, in this order:
//
//   1. sock.logout() — tells WhatsApp to unlink the device. Without it the
//      customer keeps seeing Emma listed under "Dispositivos vinculados" and
//      has to remove it by hand.
//   2. close() + unregisterClient — kills the live socket. Deleting credentials
//      from disk does NOT close an open connection: Emma kept answering that
//      business's customers until the next redeploy.
//   3. rm -rf of the session dir — drops the stored credentials.
//
// Deliberately does NOT touch the session guard: the number is leaving, and
// clearing its throttling state here would turn every "Desconectar" button in
// the panel into a bypass of the ban protection.

dashboardRoutes.post('/admin/dashboard/:id/disconnect', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const business = await businessRepo.findById(businessId)
  if (!business) return c.html('<h1>404 — Not found</h1>', 404) as Response

  // Best effort: if WhatsApp is unreachable we still tear down locally. The
  // operator asked Emma to leave, and a failed remote logout must not trap her.
  const client = getClient(businessId)
  if (client) {
    try {
      await client.logout()
    } catch (err) {
      // logout() tears the socket down in a finally block, so the connection is
      // dead either way. What is lost is the remote unlink: the device may stay
      // listed on the customer's phone until they remove it by hand.
      logger.error(
        { err, businessId },
        'dashboard: remote WhatsApp logout failed — socket closed locally, device may still be listed on the customer phone',
      )
    }
  }
  unregisterClient(businessId)

  const sessionDir = `${env.SESSIONS_DIR}/${businessId}`
  try {
    await rm(sessionDir, { recursive: true, force: true })
  } catch (err) {
    logger.error({ err, businessId, sessionDir }, 'dashboard: failed to delete session dir')
  }

  setConnectionStatus(businessId, 'logged_out')
  logger.warn(
    { businessId, whatsappNumber: business.whatsappNumber },
    'dashboard: WhatsApp unlinked by admin — Emma left this number',
  )

  const from = (await c.req.formData().catch(() => null))?.get('from')?.toString()
  const target =
    from === 'configure'
      ? `/admin/dashboard/${encodeURIComponent(businessId)}/configure`
      : `/admin/dashboard/${encodeURIComponent(businessId)}`

  return c.redirect(`${target}?secret=${encodeURIComponent(secret)}`, 302)
})
