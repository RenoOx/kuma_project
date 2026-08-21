import { rm } from 'node:fs/promises'
import type { Context } from 'hono'
import { Hono } from 'hono'
import { env } from '@/config/env.js'
import { logger } from '@/config/logger.js'
import type {
  KbAttachmentType,
  KbCategory,
  KbSendMode,
  KnowledgeBaseEntry,
} from '@/db/schema/index.js'
import * as appointmentRepo from '@/modules/appointment/appointment.repo.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import * as businessService from '@/modules/business/business.service.js'
import {
  BOOKING_MODE_LABELS,
  type BookingMode,
  type BusinessSettings,
  businessSettingsSchema,
  type DayKey,
  DEPOSIT_METHOD_LABELS,
  DEPOSIT_METHODS,
  type DepositPaymentMethod,
  NICHE_LABELS,
  type Niche,
  type Service,
} from '@/modules/business/business.settings.js'
import * as googleCalendarService from '@/modules/google/googleCalendar.service.js'
import * as knowledgeBaseService from '@/modules/knowledgeBase/knowledgeBase.service.js'
import {
  type ActiveKbCategory,
  KB_ATTACHMENT_TYPE_LABELS,
  KB_ATTACHMENT_TYPES,
  KB_CATEGORIES,
  KB_CATEGORY_LABELS,
  KB_SEND_MODE_LABELS,
  KB_SEND_MODES,
  LEGACY_KB_CATEGORIES,
} from '@/modules/knowledgeBase/knowledgeBase.types.js'
import { MAX_ENTRIES_PER_QUERY } from '@/modules/knowledgeBase/knowledgeBaseSearch.service.js'
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
  const bDis = enabled && hasBreak ? '' : 'disabled'

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

// The reference-link row only makes sense for evaluation-first services, so it
// starts hidden and toggleServiceRef shows it with the checkbox. It keeps its
// value while hidden on purpose: unchecking by accident must not silently drop
// a link the owner already saved.
function renderServiceRow(i: number, s?: Service): string {
  const requiresEvaluation = s?.requiresEvaluation ?? false
  const refHidden = requiresEvaluation ? '' : 'display:none;'

  return `<div class="service-row" id="service-row-${i}">
      <input type="text" class="form-input" name="service_${i}_name" data-field="name"
        value="${esc(s?.name ?? '')}" placeholder="ej. Corte de cabello" style="flex:1"${s ? ' required' : ''}>
      <input type="number" class="form-input" name="service_${i}_duration" data-field="duration"
        min="5" max="480" value="${s?.durationMinutes ?? ''}" placeholder="ej. 45" style="width:90px">
      <input type="number" class="form-input" name="service_${i}_price_min" data-field="price_min"
        min="0" step="0.01" value="${s?.priceMin ?? ''}" placeholder="Precio mínimo (S/)" style="width:130px">
      <input type="number" class="form-input" name="service_${i}_price_max" data-field="price_max"
        min="0" step="0.01" value="${s?.priceMax ?? ''}" placeholder="Precio máximo (S/)" style="width:130px">
      <label class="service-eval"><input type="checkbox" name="service_${i}_requires_evaluation"
        data-field="requires_evaluation"${requiresEvaluation ? ' checked' : ''}
        onchange="toggleServiceRef(this)"> Requiere evaluación previa</label>
      <button type="button" class="btn btn-ghost btn-sm" onclick="removeService(this)">✕</button>
      <div class="service-ref" data-ref-row style="${refHidden}">
        <input type="url" class="form-input" name="service_${i}_reference_url" data-field="reference_url"
          value="${esc(s?.referenceUrl ?? '')}"
          placeholder="Link de referencia (Canva, Drive, portafolio...)">
      </div>
    </div>`
}

function renderServiceRows(services: Service[]): string {
  if (services.length === 0) return renderServiceRow(0)
  return services.map((s, i) => renderServiceRow(i, s)).join('')
}

// One payment method row. The number field is hidden for 'efectivo' — there is
// no number to type — but kept in the DOM so switching back restores the value.
function renderDepositMethodRow(i: number, m?: DepositPaymentMethod): string {
  const method = m?.method ?? 'yape'
  const number = m?.number ?? ''
  const label = m?.label ?? ''
  const options = DEPOSIT_METHODS.map(
    (v) =>
      `<option value="${v}" ${method === v ? 'selected' : ''}>${esc(DEPOSIT_METHOD_LABELS[v])}</option>`,
  ).join('')

  return `<div class="service-row deposit-row" id="deposit-row-${i}">
    <select class="form-input form-select" name="deposit_method_${i}_method" data-field="method"
      style="width:150px" onchange="toggleDepositNumber(this)">${options}</select>
    <input type="text" class="form-input" name="deposit_method_${i}_number" data-field="number"
      value="${esc(number)}" placeholder="ej. 987654321" style="width:160px"
      ${method === 'efectivo' ? 'hidden' : ''}>
    <input type="text" class="form-input" name="deposit_method_${i}_label" data-field="label"
      value="${esc(label)}" placeholder="Nombre de referencia (ej. Dr. Pérez)" style="flex:1">
    <button type="button" class="btn btn-ghost btn-sm" onclick="removeDepositMethod(this)">✕</button>
  </div>`
}

function renderDepositMethodRows(methods: DepositPaymentMethod[]): string {
  return methods.map((m, i) => renderDepositMethodRow(i, m)).join('')
}

type SpecialDayRow = { date: string; label?: string; hours: DayHours }

function renderSpecialDayRow(i: number, s?: SpecialDayRow): string {
  const date = s?.date ?? ''
  const label = s?.label ?? ''
  const closed = s ? s.hours === null : false
  const open = s?.hours?.open ?? '09:00'
  const close = s?.hours?.close ?? '13:00'
  const dis = closed ? 'disabled' : ''

  return `<div class="service-row special-row" id="special-row-${i}">
    <input type="date" class="form-input" name="special_${i}_date" data-field="date"
      value="${esc(date)}" style="width:150px">
    <input type="text" class="form-input" name="special_${i}_label" data-field="label"
      value="${esc(label)}" placeholder="ej. Navidad" style="flex:1">
    <label style="display:flex;align-items:center;gap:.3rem;font-size:12px;white-space:nowrap">
      <input type="checkbox" name="special_${i}_closed" data-field="closed"
        ${closed ? 'checked' : ''} onchange="toggleSpecialClosed(${i})"> Cerrado
    </label>
    <input type="time" class="time-input" name="special_${i}_open" id="special_${i}_open"
      data-field="open" value="${open}" ${dis}>
    <input type="time" class="time-input" name="special_${i}_close" id="special_${i}_close"
      data-field="close" value="${close}" ${dis}>
    <button type="button" class="btn btn-ghost btn-sm" onclick="removeSpecialDay(this)">✕</button>
  </div>`
}

function renderSpecialDayRows(specialDays: SpecialDayRow[]): string {
  if (specialDays.length === 0) return ''
  return specialDays.map((s, i) => renderSpecialDayRow(i, s)).join('')
}

// An empty input means the field is genuinely unset, which the settings schema
// represents as null — never coerce it to 0 or NaN.
function optionalNumberField(formData: FormData, key: string): number | null {
  const raw = formData.get(key)?.toString().trim()
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isNaN(parsed) ? null : parsed
}

// referenceUrl is `.optional()` (not nullable) in the schema, so an empty input
// has to disappear from the object entirely rather than become null.
function optionalStringField(formData: FormData, key: string): string | undefined {
  return formData.get(key)?.toString().trim() || undefined
}

// Zod issue → something the business owner can act on. Only the cases an owner
// actually hits are translated; anything else falls back to the raw path so a
// new validation rule never renders as an empty message.
function humanizeSettingsIssue(path: string, message: string): string {
  const service = /^services\.(\d+)\.(\w+)$/.exec(path)
  if (service) {
    const label = `Servicio ${Number(service[1]) + 1}`
    switch (service[2]) {
      case 'priceMin':
        return `${label}: falta el precio mínimo. Si el precio depende del caso, marcá "Requiere evaluación previa".`
      case 'priceMax':
        return `${label}: el precio máximo no puede ser menor que el mínimo.`
      case 'referenceUrl':
        return `${label}: el link de referencia debe ser una URL completa (empezando con https://).`
      case 'name':
        return `${label}: falta el nombre.`
      default:
        return `${label}: ${message}`
    }
  }
  return path === '' ? message : `${path}: ${message}`
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
  const services: Service[] = []
  for (let i = 0; i < serviceCount; i++) {
    const name = formData.get(`service_${i}_name`)?.toString().trim() ?? ''
    if (!name) continue
    const referenceUrl = optionalStringField(formData, `service_${i}_reference_url`)
    services.push({
      name,
      durationMinutes: optionalNumberField(formData, `service_${i}_duration`),
      priceMin: optionalNumberField(formData, `service_${i}_price_min`),
      priceMax: optionalNumberField(formData, `service_${i}_price_max`),
      requiresEvaluation: formData.get(`service_${i}_requires_evaluation`) === 'on',
      ...(referenceUrl ? { referenceUrl } : {}),
    })
  }

  const specialDayCount = Number(formData.get('special_count') ?? 0)
  const specialDays: Array<Record<string, unknown>> = []
  for (let i = 0; i < specialDayCount; i++) {
    const date = formData.get(`special_${i}_date`)?.toString().trim() ?? ''
    if (!date) continue
    const label = formData.get(`special_${i}_label`)?.toString().trim() || undefined
    const closed = formData.get(`special_${i}_closed`) === 'on'
    if (closed) {
      specialDays.push({ date, hours: null, ...(label ? { label } : {}) })
      continue
    }
    specialDays.push({
      date,
      hours: {
        open: formData.get(`special_${i}_open`)?.toString() ?? '',
        close: formData.get(`special_${i}_close`)?.toString() ?? '',
      },
      ...(label ? { label } : {}),
    })
  }

  // Anything other than the explicit 'hybrid' radio falls back to the schema
  // default, so a malformed post can never silently flip a business to walk-ins.
  const appointmentMode =
    formData.get('appointmentMode')?.toString() === 'hybrid' ? 'hybrid' : 'appointments_only'

  // Same defensive pattern as appointmentMode: anything outside the known set
  // falls back to the schema default instead of failing the whole form.
  const nicheRaw = formData.get('niche')?.toString()
  const niche: Niche = nicheRaw && nicheRaw in NICHE_LABELS ? (nicheRaw as Niche) : 'general'

  const bookingModeRaw = formData.get('bookingMode')?.toString()
  const bookingMode: BookingMode =
    bookingModeRaw && bookingModeRaw in BOOKING_MODE_LABELS
      ? (bookingModeRaw as BookingMode)
      : 'direct'

  // Unchecked checkboxes are simply absent from the form data, so presence is
  // the value. No fallback needed: absent means false, which is the default.
  const forwardImages = formData.get('forwardImages')?.toString() === 'on'

  const requiresDeposit = formData.get('requiresDeposit')?.toString() === 'on'
  const depositAmount = optionalStringField(formData, 'depositAmount')
  const methodCount = Number(formData.get('deposit_method_count') ?? 0)
  const depositPaymentMethods: DepositPaymentMethod[] = []
  for (let i = 0; i < methodCount; i++) {
    const method = formData.get(`deposit_method_${i}_method`)?.toString()
    // A row whose method never made it through is a row the owner removed or a
    // malformed post — skipped rather than failing the whole save.
    if (!method || !DEPOSIT_METHODS.includes(method as DepositPaymentMethod['method'])) continue
    const number = optionalStringField(formData, `deposit_method_${i}_number`)
    const label = optionalStringField(formData, `deposit_method_${i}_label`)
    depositPaymentMethods.push({
      method: method as DepositPaymentMethod['method'],
      ...(number ? { number } : {}),
      ...(label ? { label } : {}),
    })
  }

  const raw = {
    niche,
    bookingMode,
    forwardImages,
    requiresDeposit,
    depositPaymentMethods,
    ...(depositAmount ? { depositAmount } : {}),
    operatingHours,
    slotDurationMinutes: isNaN(slotDuration) ? 30 : slotDuration,
    services,
    appointmentMode,
    ...(minNotice !== undefined && !isNaN(minNotice) ? { minBookingNoticeMinutes: minNotice } : {}),
    ...(specialDays.length > 0 ? { specialDays } : {}),
  }

  const parsed = businessSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => humanizeSettingsIssue(i.path.join('.'), i.message)),
    }
  }
  return { ok: true, data: parsed.data }
}

// ── Configure panel helpers ───────────────────────────────────────────────────

// Alerts render as dismissible popups instead of full-width banners so the page
// keeps the same height whatever query params came back. Only the success toast
// auto-closes: the error one carries the validation detail the owner needs in
// order to fix the form, and the rebind one carries the QR link that brings
// Emma back online — neither may evaporate on its own.
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

function checklistRow(mark: '✓' | '✕' | '○', on: boolean, name: string, meta: string): string {
  return `<div class="kb-check-row${on ? '' : ' is-missing'}">
      <span class="kb-mark ${on ? 'kb-mark-on' : 'kb-mark-off'}">${mark}</span>
      <span class="kb-check-name">${esc(name)}</span>
      <span class="kb-check-meta">${esc(meta)}</span>
    </div>`
}

// Read-only status split the way the owner needs to see it: the top group is
// what business settings already answer (so nobody files a duplicate KB entry
// for it), the bottom group is what only the knowledge base can answer.
//
// The top group reflects the actual settings rather than printing three fixed
// checkmarks — telling an owner with no services loaded that Emma "already
// knows" their services is exactly the kind of invented answer the rest of the
// product refuses to give.
//
// Counts only active entries: a disabled one is out of the prompt, so claiming
// the category is covered would be a lie.
function renderKbChecklist(params: {
  entries: KnowledgeBaseEntry[]
  serviceCount: number
  hasHours: boolean
  hasLocation: boolean
}): string {
  const counts = new Map<KbCategory, number>()
  for (const e of params.entries) {
    if (e.active) counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
  }

  const known = [
    checklistRow(
      params.serviceCount > 0 ? '✓' : '✕',
      params.serviceCount > 0,
      'Servicios y precios',
      params.serviceCount > 0
        ? `${params.serviceCount} ${params.serviceCount === 1 ? 'servicio' : 'servicios'} configurados`
        : 'Sin servicios configurados',
    ),
    checklistRow(
      params.hasHours ? '✓' : '✕',
      params.hasHours,
      'Horarios de atención',
      params.hasHours ? 'Horario semanal cargado' : 'Sin días de atención configurados',
    ),
    checklistRow(
      params.hasLocation ? '✓' : '✕',
      params.hasLocation,
      'Ubicación y contacto',
      params.hasLocation ? 'Dirección cargada' : 'Sin dirección configurada',
    ),
  ].join('')

  // `promociones` is genuinely optional — a business with nothing on sale is
  // correctly configured, so it gets a neutral mark instead of a red one.
  const needed = KB_CATEGORIES.map((cat) => {
    const count = counts.get(cat) ?? 0
    const optional = cat === 'promociones'
    if (count > 0) {
      return checklistRow(
        '✓',
        true,
        KB_CATEGORY_LABELS[cat],
        `${count} ${count === 1 ? 'entrada' : 'entradas'}`,
      )
    }
    return checklistRow(
      optional ? '○' : '✕',
      false,
      KB_CATEGORY_LABELS[cat],
      optional
        ? 'Opcional — sin entradas'
        : 'Sin entradas — Emma no podrá responder preguntas sobre este tema.',
    )
  }).join('')

  return `<div class="kb-group-title">Lo que Emma ya sabe (desde Configuración)</div>
    ${known}
    <div class="kb-group-title is-second">Lo que necesitás agregar acá</div>
    ${needed}`
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
            1. Configurar horarios y servicios
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
        <a href="/admin/dashboard/${bid}/kb?secret=${se}" class="btn btn-ghost btn-sm">Ver todas / gestionar</a>
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

// ── Configurar negocio: formulario ────────────────────────────────────────────

dashboardRoutes.get('/admin/dashboard/:id/configure', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const [business, gcEmail, kbResult] = await Promise.all([
    businessRepo.findById(businessId),
    dashRepo.getGoogleConnectedEmail(businessId),
    knowledgeBaseService.getByBusiness(businessId),
  ])
  if (!business) return c.html('<h1>404</h1>', 404) as Response

  const se = encodeURIComponent(secret)
  const bid = esc(businessId)
  const error = c.req.query('error') ? decodeURIComponent(c.req.query('error') ?? '') : null
  const saved = c.req.query('saved') === '1'
  const rebind = c.req.query('rebind')

  const toasts = [
    saved
      ? renderToast('success', 'Cambios guardados', 'La configuración quedó actualizada.', 4000)
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

  // Unvalidated jsonb straight from the row. Services saved before the
  // priceMin/priceMax split have none of the price fields, so they render as
  // empty inputs and the owner has to re-enter them — which is the intended
  // prompt, since there is no data migration.
  const services = Array.isArray(raw?.services) ? (raw.services as Service[]) : []

  const specialDays = Array.isArray(raw?.specialDays)
    ? (raw.specialDays as SpecialDayRow[]).slice().sort((a, b) => a.date.localeCompare(b.date))
    : []

  const slotDuration = raw?.slotDurationMinutes ?? 30
  const minNotice = raw?.minBookingNoticeMinutes ?? 30
  // Unvalidated jsonb: a business saved before this field existed has no mode,
  // and the visual default has to match the schema default.
  const isHybrid = raw?.appointmentMode === 'hybrid'
  const niche: Niche = raw?.niche ?? 'general'
  const bookingMode: BookingMode = raw?.bookingMode ?? 'direct'
  const forwardImages: boolean = raw?.forwardImages ?? false
  const requiresDeposit: boolean = raw?.requiresDeposit ?? false
  const depositAmount: string = raw?.depositAmount ?? ''
  const depositMethods: DepositPaymentMethod[] = Array.isArray(raw?.depositPaymentMethods)
    ? (raw.depositPaymentMethods as DepositPaymentMethod[])
    : []
  const initialServiceCount = Math.max(services.length, 1)
  const initialSpecialDayCount = specialDays.length
  const initialDepositMethodCount = depositMethods.length

  const hoursRows = DAYS.map(({ key, label }) =>
    renderDayRow(key, label, effectiveHours[key]),
  ).join('')

  const slotOptions = [15, 20, 30, 45, 60, 90, 120]
    .map(
      (v) => `<option value="${v}" ${slotDuration === v ? 'selected' : ''}>${v} minutos</option>`,
    )
    .join('')

  const body = `
    <div class="config-page">
    <a href="/admin/dashboard/${bid}?secret=${se}" class="back">← ${esc(business.name)}</a>
    <div class="page-header">
      <h1 class="page-title">Configurar — ${esc(business.name)}</h1>
    </div>
    <div class="toast-stack" role="status" aria-live="polite">${toasts}</div>

    <div class="config-layout">
      <nav class="config-nav">
        <a class="config-nav-item is-active" data-section="seccion-info" href="#seccion-info">Información</a>
        <a class="config-nav-item" data-section="seccion-horarios" href="#seccion-horarios">Horarios</a>
        <a class="config-nav-item" data-section="seccion-servicios" href="#seccion-servicios">Servicios</a>
        <a class="config-nav-item" data-section="seccion-citas" href="#seccion-citas">Citas y turnos</a>
        <a class="config-nav-item" data-section="seccion-pagos" href="#seccion-pagos">Pagos</a>
        <a class="config-nav-item" data-section="seccion-conocimiento" href="#seccion-conocimiento">Conocimiento</a>
        <a class="config-nav-item" data-section="seccion-google" href="#seccion-google">Google Calendar</a>
        <a class="config-nav-item" data-section="seccion-peligro" href="#seccion-peligro">Zona de peligro</a>
      </nav>

      <div class="config-col">

      <form id="config-form" class="config-form" method="post"
        action="/admin/dashboard/${bid}/configure?secret=${se}"
        onsubmit="return confirmNumberChange()">

        <section id="seccion-info" class="config-section">
          <div class="section-header">
            <h2 class="section-title">Información del negocio</h2>
            <p class="section-desc">Nombre, tipo de negocio, contacto y ubicación</p>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="name">Nombre del negocio</label>
              <input id="name" name="name" type="text" class="form-input"
                value="${esc(business.name)}" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="niche">Tipo de negocio</label>
              <select id="niche" name="niche" class="form-input form-select">
                ${Object.entries(NICHE_LABELS)
                  .map(
                    ([v, l]) =>
                      `<option value="${v}" ${niche === v ? 'selected' : ''}>${esc(l)}</option>`,
                  )
                  .join('')}
              </select>
            </div>
          </div>
          <div class="form-row">
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
                  .map(
                    ([v, l]) =>
                      `<option value="${v}" ${business.timezone === v ? 'selected' : ''}>${l}</option>`,
                  )
                  .join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="whatsappNumber">Número de WhatsApp del bot</label>
              <input id="whatsappNumber" name="whatsappNumber" type="text" class="form-input"
                value="${esc(business.whatsappNumber)}" placeholder="+51987654321" required
                data-original="${esc(business.whatsappNumber)}">
              <p class="form-hint" style="color:#b45309">
                Cambiar este número desconecta la sesión actual y hay que escanear un QR nuevo
                con el teléfono del número nuevo. Las citas, conversaciones e historial NO se pierden.
              </p>
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
                placeholder="+51987654321">
              <p class="form-hint">Diferente al número del bot</p>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="address">Dirección del negocio</label>
              <input id="address" name="address" type="text" class="form-input"
                value="${esc(business.address ?? '')}"
                placeholder="ej. Av. Ejército 820, Yanahuara, Arequipa">
              <p class="form-hint">Emma la responde cuando preguntan dónde están o cómo llegar</p>
            </div>
            <div class="form-group">
              <label class="form-label" for="googleMapsUrl">Link de Google Maps</label>
              <input id="googleMapsUrl" name="googleMapsUrl" type="url" class="form-input"
                value="${esc(business.googleMapsUrl ?? '')}" placeholder="https://maps.app.goo.gl/...">
              <p class="form-hint">Complementario a la dirección — Emma manda los dos juntos</p>
            </div>
          </div>
        </section>

        <section id="seccion-horarios" class="config-section">
          <div class="section-header">
            <h2 class="section-title">Horarios de atención</h2>
            <p class="section-desc">Horario semanal, modo de atención y fechas puntuales</p>
          </div>
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

          <div class="subsection">
            <h3 class="subsection-title">Modo de atención</h3>
            <p class="subsection-desc">Qué le ofrece Emma a alguien que escribe queriendo venir</p>
            <div class="mode-options">
            <label class="mode-option">
              <input type="radio" name="appointmentMode" value="appointments_only"
                ${isHybrid ? '' : 'checked'}>
              <span>
                <span class="mode-option-title">Solo con cita previa</span>
                <span class="mode-option-desc" style="display:block">
                  Emma siempre ofrece agendar. Es el modo por defecto.
                </span>
              </span>
            </label>
            <label class="mode-option">
              <input type="radio" name="appointmentMode" value="hybrid" ${isHybrid ? 'checked' : ''}>
              <span>
                <span class="mode-option-title">Presencial + citas opcionales</span>
                <span class="mode-option-desc" style="display:block">
                  Atienden por orden de llegada y además aceptan reservas. Emma pregunta
                  al cliente qué prefiere en vez de asumir que quiere cita.
                </span>
              </span>
            </label>
            </div>
          </div>

          <div class="subsection">
            <h3 class="subsection-title">Días especiales</h3>
            <p class="subsection-desc">
              Feriados u horarios puntuales que reemplazan el horario semanal para una fecha específica.
            </p>
            <div id="special-days-container">
              ${renderSpecialDayRows(specialDays)}
            </div>
            <input type="hidden" name="special_count" id="special_count" value="${initialSpecialDayCount}">
            <button type="button" class="btn btn-ghost btn-sm" style="margin-top:.5rem" onclick="addSpecialDay()">
              + Agregar día especial
            </button>
          </div>
        </section>

        <section id="seccion-servicios" class="config-section">
          <div class="section-header">
            <h2 class="section-title">Servicios</h2>
            <p class="section-desc">
              La duración es opcional: si la dejás vacía, ese servicio no tiene duración propia.
              El precio mínimo es obligatorio salvo que marques "Requiere evaluación previa".
            </p>
          </div>
          <div class="svc-head">
            <span style="flex:1">Servicio</span>
            <span style="width:90px">Duración (min)</span>
            <span style="width:130px">Precio mín. (S/)</span>
            <span style="width:130px">Precio máx. (S/)</span>
            <span style="width:32px"></span>
          </div>
          <div id="services-container">
            ${renderServiceRows(services)}
          </div>
          <input type="hidden" name="service_count" id="service_count" value="${initialServiceCount}">
          <button type="button" class="btn btn-ghost btn-sm" style="margin-top:.5rem" onclick="addService()">
            + Agregar servicio
          </button>
        </section>

        <section id="seccion-citas" class="config-section">
          <div class="section-header">
            <h2 class="section-title">Citas y turnos</h2>
            <p class="section-desc">Cómo Emma reserva, con cuánta anticipación y qué te reenvía</p>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="bookingMode">Modo de reserva</label>
              <select id="bookingMode" name="bookingMode" class="form-input form-select">
                ${Object.entries(BOOKING_MODE_LABELS)
                  .map(
                    ([v, l]) =>
                      `<option value="${v}" ${bookingMode === v ? 'selected' : ''}>${esc(l)}</option>`,
                  )
                  .join('')}
              </select>
              <p class="form-hint">
                Con "Requiere aprobación" Emma no confirma la cita: la deja por aprobar
                y te manda la solicitud por WhatsApp.
              </p>
            </div>
            <div class="form-group">
              <label class="form-label" for="slotDurationMinutes">Duración de cada turno</label>
              <select id="slotDurationMinutes" name="slotDurationMinutes" class="form-input form-select">
                ${slotOptions}
              </select>
              <p class="form-hint">Intervalo entre turnos disponibles en el calendario</p>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="minBookingNoticeMinutes">Anticipación mínima (minutos)</label>
              <input id="minBookingNoticeMinutes" name="minBookingNoticeMinutes" type="number"
                class="form-input" min="0" max="1440" value="${minNotice}">
              <p class="form-hint">Mínimo tiempo entre "ahora" y el primer turno agendable (0 = sin restricción, default: 30)</p>
            </div>
          </div>
          <div class="subsection">
            <label class="check-field" for="forwardImages">
              <input type="checkbox" id="forwardImages" name="forwardImages"
                ${forwardImages ? 'checked' : ''}>
              Reenviar imágenes de clientes al dueño
            </label>
            <p class="form-hint">
              Emma te manda la foto por WhatsApp cuando ella misma la pidió (por ejemplo
              un comprobante de pago) o cuando el paciente tiene una cita por aprobar.
              Las fotos que nadie pidió no se reenvían.
            </p>
          </div>
        </section>

        <section id="seccion-pagos" class="config-section">
          <div class="section-header">
            <h2 class="section-title">Pagos</h2>
            <p class="section-desc">
              Si pedís adelanto, Emma no agenda hasta recibir la captura del pago.
            </p>
          </div>
          <div class="subsection">
            <label class="check-field" for="requiresDeposit">
              <input type="checkbox" id="requiresDeposit" name="requiresDeposit"
                ${requiresDeposit ? 'checked' : ''} onchange="toggleDeposit()">
              ¿Requiere adelanto para confirmar cita?
            </label>
            <p class="form-hint">
              Con esto activo, Emma le pide la captura al cliente antes de agendar y te
              reenvía la imagen aunque el reenvío de imágenes esté desactivado.
            </p>
          </div>
          <div id="deposit-fields" ${requiresDeposit ? '' : 'hidden'}>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="depositAmount">Monto del adelanto</label>
                <input id="depositAmount" name="depositAmount" type="text" class="form-input"
                  value="${esc(depositAmount)}" placeholder="ej. S/ 20">
                <p class="form-hint">Texto libre: "S/ 20", "el 50%", "S/ 20 por persona"</p>
              </div>
            </div>
            <div class="svc-head">
              <span style="width:150px">Método</span>
              <span style="width:160px">Número</span>
              <span style="flex:1">Nombre de referencia</span>
              <span style="width:32px"></span>
            </div>
            <div id="deposit-methods-container">
              ${renderDepositMethodRows(depositMethods)}
            </div>
            <input type="hidden" name="deposit_method_count" id="deposit_method_count"
              value="${initialDepositMethodCount}">
            <button type="button" class="btn btn-ghost btn-sm" style="margin-top:.5rem"
              onclick="addDepositMethod()">
              + Agregar método de pago
            </button>
          </div>
        </section>

      </form>

      <section id="seccion-conocimiento" class="config-section">
        <div class="section-header">
          <h2 class="section-title">Conocimiento del negocio</h2>
          <p class="section-desc">
            Qué temas puede responder Emma más allá de los datos de esta página. Se edita aparte.
          </p>
        </div>
        ${
          kbResult.ok
            ? renderKbChecklist({
                entries: kbResult.data,
                serviceCount: services.length,
                hasHours: DAYS.some(({ key }) => effectiveHours[key] !== null),
                hasLocation: (business.address ?? '').trim() !== '',
              })
            : '<p class="section-desc">No pudimos cargar la base de conocimiento.</p>'
        }
        <div style="margin-top:20px">
          <a href="/admin/dashboard/${bid}/kb?secret=${se}" class="btn btn-ghost btn-sm">
            Editar base de conocimiento →
          </a>
        </div>
      </section>

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
    let _svcCounter = ${initialServiceCount};

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
        ' min="5" max="480" placeholder="ej. 45" style="width:90px">' +
        '<input type="number" class="form-input" name="service_' + idx + '_price_min" data-field="price_min"' +
        ' min="0" step="0.01" placeholder="Precio mínimo (S/)" style="width:130px">' +
        '<input type="number" class="form-input" name="service_' + idx + '_price_max" data-field="price_max"' +
        ' min="0" step="0.01" placeholder="Precio máximo (S/)" style="width:130px">' +
        '<label class="service-eval"><input type="checkbox" name="service_' + idx + '_requires_evaluation"' +
        ' data-field="requires_evaluation" onchange="toggleServiceRef(this)"> Requiere evaluación previa</label>' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="removeService(this)">✕</button>' +
        '<div class="service-ref" data-ref-row style="display:none">' +
        '<input type="url" class="form-input" name="service_' + idx + '_reference_url"' +
        ' data-field="reference_url" placeholder="Link de referencia (Canva, Drive, portafolio...)">' +
        '</div>';
      document.getElementById('services-container').appendChild(row);
      document.getElementById('service_count').value = _svcCounter;
    }

    // The reference link is only meaningful for evaluation-first services.
    // Hiding keeps the value: unchecking by accident must not drop a saved link.
    function toggleServiceRef(checkbox) {
      const row = checkbox.closest('.service-row');
      const ref = row.querySelector('[data-ref-row]');
      if (ref) ref.style.display = checkbox.checked ? '' : 'none';
    }

    function removeService(btn) {
      const row = btn.closest('.service-row');
      if (document.querySelectorAll('#services-container .service-row').length <= 1) {
        alert('El negocio debe tener al menos un servicio.');
        return;
      }
      row.remove();
      reindexServices();
    }

    function reindexServices() {
      const rows = document.querySelectorAll('#services-container .service-row');
      rows.forEach(function(row, i) {
        row.querySelector('[data-field="name"]').name = 'service_' + i + '_name';
        row.querySelector('[data-field="duration"]').name = 'service_' + i + '_duration';
        row.querySelector('[data-field="price_min"]').name = 'service_' + i + '_price_min';
        row.querySelector('[data-field="price_max"]').name = 'service_' + i + '_price_max';
        row.querySelector('[data-field="requires_evaluation"]').name = 'service_' + i + '_requires_evaluation';
        row.querySelector('[data-field="reference_url"]').name = 'service_' + i + '_reference_url';
      });
      _svcCounter = rows.length;
      document.getElementById('service_count').value = _svcCounter;
    }

    let _depositCounter = ${initialDepositMethodCount};

    function toggleDeposit() {
      const on = document.getElementById('requiresDeposit').checked;
      document.getElementById('deposit-fields').hidden = !on;
    }

    // 'efectivo' has no number to type. Hidden rather than removed so switching
    // back to Yape restores whatever was already there.
    function toggleDepositNumber(select) {
      const row = select.closest('.deposit-row');
      const number = row.querySelector('[data-field="number"]');
      if (number) number.hidden = select.value === 'efectivo';
    }

    function addDepositMethod() {
      const idx = _depositCounter++;
      const row = document.createElement('div');
      row.className = 'service-row deposit-row';
      row.id = 'deposit-row-' + idx;
      row.innerHTML =
        '<select class="form-input form-select" name="deposit_method_' + idx + '_method"' +
        ' data-field="method" style="width:150px" onchange="toggleDepositNumber(this)">' +
        ${jsonForScript(
          DEPOSIT_METHODS.map(
            (v) => `<option value="${v}">${DEPOSIT_METHOD_LABELS[v]}</option>`,
          ).join(''),
        )} +
        '</select>' +
        '<input type="text" class="form-input" name="deposit_method_' + idx + '_number"' +
        ' data-field="number" placeholder="ej. 987654321" style="width:160px">' +
        '<input type="text" class="form-input" name="deposit_method_' + idx + '_label"' +
        ' data-field="label" placeholder="Nombre de referencia (ej. Dr. Pérez)" style="flex:1">' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="removeDepositMethod(this)">✕</button>';
      document.getElementById('deposit-methods-container').appendChild(row);
      document.getElementById('deposit_method_count').value = _depositCounter;
    }

    function removeDepositMethod(btn) {
      btn.closest('.deposit-row').remove();
      reindexDepositMethods();
    }

    function reindexDepositMethods() {
      const rows = document.querySelectorAll('#deposit-methods-container .deposit-row');
      rows.forEach(function(row, i) {
        row.querySelector('[data-field="method"]').name = 'deposit_method_' + i + '_method';
        row.querySelector('[data-field="number"]').name = 'deposit_method_' + i + '_number';
        row.querySelector('[data-field="label"]').name = 'deposit_method_' + i + '_label';
      });
      _depositCounter = rows.length;
      document.getElementById('deposit_method_count').value = _depositCounter;
    }

    let _specialCounter = ${initialSpecialDayCount};

    function addSpecialDay() {
      const idx = _specialCounter++;
      const row = document.createElement('div');
      row.className = 'service-row special-row';
      row.id = 'special-row-' + idx;
      row.innerHTML =
        '<input type="date" class="form-input" name="special_' + idx + '_date" data-field="date" style="width:150px">' +
        '<input type="text" class="form-input" name="special_' + idx + '_label" data-field="label"' +
        ' placeholder="ej. Navidad" style="flex:1">' +
        '<label style="display:flex;align-items:center;gap:.3rem;font-size:12px;white-space:nowrap">' +
        '<input type="checkbox" name="special_' + idx + '_closed" data-field="closed" onchange="toggleSpecialClosed(' + idx + ')"> Cerrado</label>' +
        '<input type="time" class="time-input" name="special_' + idx + '_open" id="special_' + idx + '_open" data-field="open" value="09:00">' +
        '<input type="time" class="time-input" name="special_' + idx + '_close" id="special_' + idx + '_close" data-field="close" value="13:00">' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="removeSpecialDay(this)">✕</button>';
      document.getElementById('special-days-container').appendChild(row);
      document.getElementById('special_count').value = _specialCounter;
    }

    function removeSpecialDay(btn) {
      btn.closest('.special-row').remove();
      reindexSpecialDays();
    }

    function reindexSpecialDays() {
      const rows = document.querySelectorAll('#special-days-container .special-row');
      rows.forEach(function(row, i) {
        row.querySelector('[data-field="date"]').name = 'special_' + i + '_date';
        row.querySelector('[data-field="label"]').name = 'special_' + i + '_label';
        row.querySelector('[data-field="closed"]').name = 'special_' + i + '_closed';
        row.querySelector('[data-field="closed"]').setAttribute('onchange', 'toggleSpecialClosed(' + i + ')');
        row.querySelector('[data-field="open"]').name = 'special_' + i + '_open';
        row.querySelector('[data-field="open"]').id = 'special_' + i + '_open';
        row.querySelector('[data-field="close"]').name = 'special_' + i + '_close';
        row.querySelector('[data-field="close"]').id = 'special_' + i + '_close';
      });
      _specialCounter = rows.length;
      document.getElementById('special_count').value = _specialCounter;
    }

    function toggleSpecialClosed(i) {
      const closed = document.querySelector('#special-row-' + i + ' [data-field="closed"]').checked;
      const openEl = document.getElementById('special_' + i + '_open');
      const closeEl = document.getElementById('special_' + i + '_close');
      if (openEl) openEl.disabled = closed;
      if (closeEl) closeEl.disabled = closed;
    }

    // Only toasts that opted in disappear on their own. The error and rebind
    // ones stay until dismissed — see renderToast.
    document.querySelectorAll('.toast[data-autoclose]').forEach(function(t) {
      setTimeout(function() { t.remove() }, parseInt(t.getAttribute('data-autoclose'), 10));
    });

    // Scroll spy. The rootMargin band ignores the sticky topbar and the bottom
    // half of the viewport, so the highlighted item is the section the operator
    // is actually reading, not whatever is barely poking into view.
    (function() {
      var items = Array.prototype.slice.call(document.querySelectorAll('.config-nav-item'));
      var sections = items
        .map(function(i) { return document.getElementById(i.getAttribute('data-section')) })
        .filter(Boolean);
      if (sections.length === 0 || !('IntersectionObserver' in window)) return;

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

  return c.html(layout(`Configurar — ${business.name}`, body, secret))
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
  // Stored normalized so the routing comparison in whatsapp/handler has a
  // canonical value to match against, whatever shape the operator typed.
  const ownerWhatsappNumber = normalizePhone(formData.get('ownerWhatsappNumber')?.toString())
  const googleMapsUrl = formData.get('googleMapsUrl')?.toString().trim() || null
  const address = formData.get('address')?.toString().trim() || null
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

  // Validate settings BEFORE any write: a number change tears down the WhatsApp
  // session, and we must not do that only to bail out on an unrelated form error.
  const parsed = await parseSettingsFromForm(formData)
  if (!parsed.ok) {
    return configureError(parsed.errors.join(' | '))
  }

  if (numberChanged) {
    try {
      await businessRepo.update(businessId, { whatsappNumber })
    } catch (err) {
      logger.error({ err, businessId, whatsappNumber }, 'dashboard: whatsapp number update failed')
      return configureError('No se pudo actualizar el número. ¿Ya está registrado en otro negocio?')
    }
    logger.info(
      { businessId, from: business.whatsappNumber, to: whatsappNumber },
      'dashboard: bot whatsapp number changed by admin',
    )
  }

  if (name && name !== business.name) {
    await businessRepo.update(businessId, { name })
  }
  if (
    timezone !== business.timezone ||
    ownerName !== business.ownerName ||
    ownerWhatsappNumber !== business.ownerWhatsappNumber ||
    googleMapsUrl !== business.googleMapsUrl ||
    address !== business.address
  ) {
    await businessRepo.update(businessId, {
      timezone,
      ownerName,
      ownerWhatsappNumber,
      googleMapsUrl,
      address,
    })
  }

  // Preserve existing botPaused state (managed by the bot, not by this form)
  const existingRaw = business.settings as Partial<BusinessSettings>
  const newSettings = {
    ...parsed.data,
    botPaused: existingRaw?.botPaused ?? null,
  }

  await businessRepo.update(businessId, { settings: newSettings as Record<string, unknown> })

  if (!numberChanged) {
    return c.redirect(`/admin/dashboard/${bid}/configure?secret=${se}&saved=1`, 302)
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

// ── Vista: Base de conocimiento (listar + crear + editar + eliminar) ──────────

function kbCategoryOptions(selected?: string): string {
  return KB_CATEGORIES.map(
    (cat) =>
      `<option value="${cat}" ${selected === cat ? 'selected' : ''}>${esc(KB_CATEGORY_LABELS[cat])}</option>`,
  ).join('')
}

function kbSendModeOptions(selected?: string): string {
  return KB_SEND_MODES.map(
    (mode) =>
      `<option value="${mode}" ${selected === mode ? 'selected' : ''}>${esc(KB_SEND_MODE_LABELS[mode])}</option>`,
  ).join('')
}

function kbAttachmentTypeOptions(selected?: string): string {
  return KB_ATTACHMENT_TYPES.map(
    (type) =>
      `<option value="${type}" ${selected === type ? 'selected' : ''}>${esc(KB_ATTACHMENT_TYPE_LABELS[type])}</option>`,
  ).join('')
}

function kbSendModeTag(mode: KbSendMode): string {
  return `<span class="kb-tag">${esc(KB_SEND_MODE_LABELS[mode])}</span>`
}

// ── KB entry suggestions ──────────────────────────────────────────────────────
//
// Frontend-only templates: nothing here is stored, validated or sent anywhere.
// They exist because an owner staring at an empty textarea writes nothing, and
// an empty knowledge base is the single most common reason Emma has to say "no
// tengo esa información".
//
// Keyed by niche because the panel is multi-tenant. A barbershop owner offered a
// template about whether teeth whitening damages enamel learns that this panel
// was not built for them — so the clinical set is gated to dental/salud and
// every other niche gets its own vocabulary.
//
// Square brackets mark what the owner must replace. The form counts them and
// selects the first one after inserting, since a textarea cannot render them
// styled.

interface KbSuggestion {
  label: string
  title: string
  content: string
}

type KbSuggestionMap = Partial<Record<ActiveKbCategory, KbSuggestion[]>>

// Payment terms and appointment rules read the same for a barbershop and a
// dental clinic, so every niche gets these two.
const KB_SUGGESTIONS_COMMON: KbSuggestion[] = [
  {
    label: 'Formas de pago',
    title: 'Formas de pago',
    content:
      'Aceptamos [efectivo / Yape / Plin / transferencia]. Para confirmar tu cita se requiere un adelanto de S/ [monto]. Puedes pagar por [Yape/Plin] al [número] ([nombre de referencia]). Mándanos la captura del pago para confirmar.',
  },
  {
    label: 'Citas y cancelaciones',
    title: 'Citas y cancelaciones',
    content:
      'Las citas se confirman con [el local]. Llegar [10] minutos antes de la hora agendada. Cancelaciones con al menos [24] horas de anticipación. Reprogramación sin costo si se avisa a tiempo. [Menores de edad deben venir acompañados de un adulto.]',
  },
]

const KB_EVALUATION_SUGGESTION: KbSuggestion = {
  label: 'Consulta de evaluación',
  title: 'Consulta de evaluación',
  content:
    'Antes de iniciar cualquier tratamiento, el doctor realiza una evaluación para determinar el plan adecuado. La consulta tiene un costo de S/ [monto]. [Si decides realizarte el tratamiento, el costo de la consulta se descuenta del precio total. / El costo de la consulta es independiente del tratamiento.]',
}

const KB_FAQ_BY_NICHE: Record<Niche, KbSuggestion[]> = {
  dental: [
    {
      label: 'Preguntas sobre tratamientos',
      title: 'Preguntas frecuentes',
      content:
        '¿Duele la limpieza dental? No, es un procedimiento indoloro.\n¿Cada cuánto debo hacerme limpieza? Cada 6 meses idealmente.\n¿El blanqueamiento daña los dientes? No, es seguro y supervisado por el doctor.\n¿Atienden niños? [Sí, desde los X años.]',
    },
    {
      label: 'Primera visita',
      title: 'Primera visita',
      content:
        'En tu primera cita el doctor realiza una evaluación general. Traer DNI. Si tomas algún medicamento, informar antes del tratamiento. [Cepillarse los dientes antes de venir. Si tienes miedo o ansiedad, avísanos para que el doctor tome las precauciones necesarias.]',
    },
    {
      label: 'Urgencias',
      title: 'Urgencias dentales',
      content:
        'Si tienes dolor severo, un diente roto, golpe en la boca o sangrado que no para, comunícate inmediatamente. Atendemos urgencias dentro del horario de atención.',
    },
  ],
  salud: [
    {
      label: 'Preguntas sobre la atención',
      title: 'Preguntas frecuentes',
      content:
        '¿Cuánto dura una sesión? [X] minutos.\n¿Necesito una orden médica? [Sí / No].\n¿Atienden por seguro? [Sí, trabajamos con X / No, solo particular].\n¿Cada cuánto debo venir a control? [Cada X meses.]',
    },
    {
      label: 'Primera visita',
      title: 'Primera visita',
      content:
        'En tu primera cita [el especialista] realiza una evaluación general. Traer DNI [y los exámenes previos que tengas]. Si tomas algún medicamento o tienes alguna condición de salud, informar antes de la consulta.',
    },
    {
      label: 'Urgencias',
      title: 'Urgencias',
      content:
        'Si presentas [dolor severo / fiebre alta / un síntoma que empeora de golpe], comunícate inmediatamente. Atendemos urgencias dentro del horario de atención.',
    },
  ],
  barberia: [
    {
      label: 'Preguntas frecuentes',
      title: 'Preguntas frecuentes',
      content:
        '¿Atienden sin cita? [Sí, pero con cita no esperas.]\n¿Cortan a niños? [Sí, desde los X años.]\n¿Cada cuánto conviene cortarse? [Cada 3 o 4 semanas para mantener la forma.]\n¿El tinte incluye el corte? [No, son servicios aparte.]',
    },
    {
      label: 'Primera visita',
      title: 'Primera visita',
      content:
        'Si es tu primera vez, cuéntanos qué corte buscas o trae una foto de referencia. [Llegar X minutos antes.] Si tienes alguna alergia a tintes o productos, avísanos antes.',
    },
  ],
  estetica: [
    {
      label: 'Preguntas frecuentes',
      title: 'Preguntas frecuentes',
      content:
        '¿Cuánto duran las uñas en gel? [3 a 4 semanas.]\n¿Puedo venir con trabajo de otro salón? [Sí, el retiro se cobra aparte.]\n¿El tratamiento duele? [No, es indoloro.]\n¿Atienden menores? [Sí, acompañadas de un adulto.]',
    },
    {
      label: 'Primera visita',
      title: 'Primera visita',
      content:
        'Cuéntanos qué servicio buscas y si tienes alguna alergia o condición en la piel o las uñas. [Llegar X minutos antes.] Si vienes con trabajo previo de otro salón, avísanos para calcular el tiempo del retiro.',
    },
  ],
  general: [
    {
      label: 'Preguntas frecuentes',
      title: 'Preguntas frecuentes',
      content:
        '¿Atienden sin cita? [Sí / No, solo con cita previa.]\n¿Cuánto dura la atención? [X minutos.]\n¿Atienden menores? [Sí, acompañados de un adulto.]\n[Agrega acá las preguntas que más te hacen por WhatsApp.]',
    },
  ],
}

// `promociones` deliberately has no templates: an offer is specific to the
// business and the month, and a canned one would be worse than an empty box.
function kbSuggestionsFor(niche: Niche): KbSuggestionMap {
  const clinical = niche === 'dental' || niche === 'salud'
  return {
    politicas: clinical
      ? [...KB_SUGGESTIONS_COMMON, KB_EVALUATION_SUGGESTION]
      : KB_SUGGESTIONS_COMMON,
    informacion_general: KB_FAQ_BY_NICHE[niche],
  }
}

// `settings` is unvalidated jsonb, so an unknown or missing niche falls back to
// the schema default instead of indexing the suggestion map with garbage.
function nicheOf(settings: unknown): Niche {
  const raw = (settings as Partial<BusinessSettings> | null)?.niche
  return raw && raw in NICHE_LABELS ? (raw as Niche) : 'general'
}

// JSON destined for a <script> block. Escaping `<` is what stops a future
// suggestion containing "</script>" from closing the tag early.
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

// The create form and the edit form share every field; only the action URL and
// the prefilled values differ. A null `entry` renders the "new entry" variant.
function kbEntryForm(
  businessId: string,
  secret: string,
  entry: KnowledgeBaseEntry | null,
  niche: Niche,
): string {
  const se = encodeURIComponent(secret)
  const bid = esc(businessId)
  const action = entry
    ? `/admin/dashboard/${bid}/kb/${esc(entry.id)}?secret=${se}`
    : `/admin/dashboard/${bid}/kb?secret=${se}`
  const keywords = entry?.triggerKeywords?.join(', ') ?? ''

  return `
    <form method="post" action="${action}">
      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="title">Título</label>
          <input id="title" name="title" type="text" class="form-input" maxlength="120"
            value="${esc(entry?.title ?? '')}" placeholder="Nombre corto de la entrada">
          <p class="form-hint">Si lo dejás vacío se genera con los primeros 50 caracteres del contenido.</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="category">Categoría</label>
          <select id="category" name="category" class="form-input form-select" required
            onchange="kbRenderSuggestions()">
            ${kbCategoryOptions(entry?.category)}
          </select>
        </div>
      </div>

      <div class="form-group" id="kb-suggestions-group">
        <p class="form-hint" id="kb-suggestions-hint" style="margin-top:0"></p>
        <div class="kb-chips" id="kb-chips"></div>
      </div>

      <div class="form-group">
        <label class="form-label" for="content">Contenido</label>
        <textarea id="content" name="content" class="form-input" rows="6" required
          oninput="kbUpdatePlaceholderCount()"
          placeholder="Lo que Emma debe saber">${esc(entry?.content ?? '')}</textarea>
        <p class="form-hint" id="kb-placeholder-count" style="display:none"></p>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="attachmentType">Tipo de adjunto</label>
          <select id="attachmentType" name="attachmentType" class="form-input form-select"
            onchange="kbToggleAttachment()">
            ${kbAttachmentTypeOptions(entry?.attachmentType)}
          </select>
        </div>
        <div class="form-group" id="kb-attachment-url-group">
          <label class="form-label" for="attachmentUrl">URL del adjunto</label>
          <input id="attachmentUrl" name="attachmentUrl" type="url" class="form-input"
            value="${esc(entry?.attachmentUrl ?? '')}" placeholder="https://...">
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="sendMode">Modo de envío</label>
          <select id="sendMode" name="sendMode" class="form-input form-select"
            onchange="kbToggleKeywords()">
            ${kbSendModeOptions(entry?.sendMode)}
          </select>
          <p class="form-hint">
            <strong>Siempre</strong>: entra en todas las respuestas.
            <strong>Bajo pedido</strong>: solo si el cliente pregunta por esa categoría.
            <strong>Por palabras clave</strong>: solo si el mensaje contiene alguna keyword.
          </p>
        </div>
        <div class="form-group" id="kb-keywords-group">
          <label class="form-label" for="triggerKeywords">Palabras clave</label>
          <input id="triggerKeywords" name="triggerKeywords" type="text" class="form-input"
            value="${esc(keywords)}" placeholder="estacionamiento, parqueo, cochera">
          <p class="form-hint">Separadas por coma. Solo se usan con "Por palabras clave".</p>
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="active">Estado</label>
          <select id="active" name="active" class="form-input form-select">
            <option value="1" ${entry?.active !== false ? 'selected' : ''}>Activa</option>
            <option value="0" ${entry?.active === false ? 'selected' : ''}>Desactivada</option>
          </select>
          <p class="form-hint">Desactivar la saca del prompt sin borrarla.</p>
        </div>
      </div>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary">${entry ? 'Guardar cambios' : 'Crear entrada'}</button>
        <a href="/admin/dashboard/${bid}/kb?secret=${se}" class="btn btn-ghost">Cancelar</a>
      </div>
    </form>

    <script>
      function kbToggleAttachment() {
        var type = document.getElementById('attachmentType').value
        document.getElementById('kb-attachment-url-group').style.display = type === 'none' ? 'none' : ''
      }
      function kbToggleKeywords() {
        var mode = document.getElementById('sendMode').value
        document.getElementById('kb-keywords-group').style.display = mode === 'trigger_based' ? '' : 'none'
      }

      // Templates only — nothing here is submitted. The owner can ignore them
      // entirely and type their own text.
      var KB_SUGGESTIONS = ${jsonForScript(kbSuggestionsFor(niche))}
      var KB_PLACEHOLDER = /\\[[^\\]]*\\]/

      function kbRenderSuggestions() {
        var cat = document.getElementById('category').value
        var list = KB_SUGGESTIONS[cat] || []
        var chips = document.getElementById('kb-chips')
        var hint = document.getElementById('kb-suggestions-hint')

        chips.innerHTML = ''
        if (list.length > 0) {
          hint.textContent = 'Sugerencias: hacé click para rellenar el formulario. Lo que quede entre corchetes lo reemplazás vos.'
        } else if (cat === 'promociones') {
          hint.textContent = 'Agrega ofertas temporales, campañas o descuentos vigentes.'
        } else {
          hint.textContent = ''
        }

        list.forEach(function(s, i) {
          var chip = document.createElement('button')
          chip.type = 'button'
          chip.className = 'suggestion-chip'
          chip.textContent = s.label
          chip.onclick = function() { kbApplySuggestion(cat, i, chip) }
          chips.appendChild(chip)
        })

        // Restart the fade so switching category reads as a change, not a jump.
        chips.classList.remove('is-in')
        void chips.offsetWidth
        chips.classList.add('is-in')
      }

      function kbApplySuggestion(cat, index, chip) {
        var suggestion = (KB_SUGGESTIONS[cat] || [])[index]
        if (!suggestion) return
        var titleEl = document.getElementById('title')
        var contentEl = document.getElementById('content')

        var hasText = titleEl.value.trim() !== '' || contentEl.value.trim() !== ''
        if (hasText && !confirm('¿Reemplazar el contenido actual?')) return

        titleEl.value = suggestion.title
        contentEl.value = suggestion.content

        Array.prototype.forEach.call(document.querySelectorAll('.suggestion-chip'), function(c) {
          c.classList.remove('selected')
        })
        chip.classList.add('selected')

        kbUpdatePlaceholderCount()

        // A textarea cannot render the [placeholders] styled, so instead we drop
        // the caret on the first one already selected: the owner starts typing
        // and it is replaced.
        var match = KB_PLACEHOLDER.exec(contentEl.value)
        contentEl.focus()
        if (match) contentEl.setSelectionRange(match.index, match.index + match[0].length)
      }

      function kbUpdatePlaceholderCount() {
        var value = document.getElementById('content').value
        var out = document.getElementById('kb-placeholder-count')
        var found = value.match(new RegExp(KB_PLACEHOLDER.source, 'g')) || []
        out.style.display = found.length > 0 ? '' : 'none'
        out.textContent = found.length === 1
          ? '1 campo entre corchetes por completar'
          : found.length + ' campos entre corchetes por completar'
      }

      kbToggleAttachment()
      kbToggleKeywords()
      kbRenderSuggestions()
      kbUpdatePlaceholderCount()
    </script>`
}

function kbEntryCard(businessId: string, secret: string, e: KnowledgeBaseEntry): string {
  const se = encodeURIComponent(secret)
  const bid = esc(businessId)
  const preview = e.content.length > 180 ? `${e.content.slice(0, 180)}…` : e.content
  const attachment = e.attachmentUrl
    ? `<a href="${esc(e.attachmentUrl)}" target="_blank" rel="noopener">${esc(KB_ATTACHMENT_TYPE_LABELS[e.attachmentType])} adjunto</a>`
    : ''
  const keywords =
    e.sendMode === 'trigger_based' && e.triggerKeywords && e.triggerKeywords.length > 0
      ? `Palabras clave: ${esc(e.triggerKeywords.join(', '))}`
      : ''
  const meta = [attachment, keywords].filter((s) => s !== '').join(' · ')

  return `<div class="kb-card">
    <div class="kb-card-main">
      <div class="kb-card-title">
        ${esc(e.title)}
        ${kbSendModeTag(e.sendMode)}
        ${e.active ? '' : '<span class="kb-tag">Desactivada</span>'}
      </div>
      <div class="kb-card-preview">${esc(preview)}</div>
      ${meta ? `<div class="kb-card-meta">${meta}</div>` : ''}
    </div>
    <div class="kb-card-actions">
      <a href="/admin/dashboard/${bid}/kb/${esc(e.id)}/edit?secret=${se}" class="btn btn-ghost btn-sm">Editar</a>
      <form method="post" action="/admin/dashboard/${bid}/kb/${esc(e.id)}/delete?secret=${se}" style="display:inline"
        onsubmit="return confirm('¿Eliminar esta entrada? No se puede deshacer.')">
        <button type="submit" class="btn btn-danger btn-sm">Eliminar</button>
      </form>
    </div>
  </div>`
}

dashboardRoutes.get('/admin/dashboard/:id/kb', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const business = await businessRepo.findById(businessId)
  if (!business) return c.html('<h1>404</h1>', 404) as Response

  const result = await knowledgeBaseService.getByBusiness(businessId)
  if (!result.ok) {
    logger.error({ err: result.error, businessId }, 'dashboard: failed to load knowledge base')
    return c.html(
      layout(
        'Base de conocimiento',
        `<div class="alert alert-error">${esc(result.error.userMessage)}</div>`,
        secret,
      ),
      500,
    ) as Response
  }

  const se = encodeURIComponent(secret)
  const bid = esc(businessId)
  const saved = c.req.query('saved') === '1'
  const error = c.req.query('error') ? decodeURIComponent(c.req.query('error') ?? '') : null
  const showNew = c.req.query('new') === '1'
  const rawFilter = c.req.query('category')
  const activeFilter = KB_CATEGORIES.find((cat) => cat === rawFilter) ?? null

  const visible = activeFilter
    ? result.data.filter((e) => e.category === activeFilter)
    : result.data

  const filterLinks = [
    `<a href="/admin/dashboard/${bid}/kb?secret=${se}" class="kb-filter ${activeFilter ? '' : 'is-active'}">Todas (${result.data.length})</a>`,
    ...KB_CATEGORIES.map((cat) => {
      const count = result.data.filter((e) => e.category === cat).length
      const cls = activeFilter === cat ? 'is-active' : ''
      return `<a href="/admin/dashboard/${bid}/kb?secret=${se}&category=${cat}" class="kb-filter ${cls}">${esc(KB_CATEGORY_LABELS[cat])} (${count})</a>`
    }),
  ].join('')

  const groups = KB_CATEGORIES.map((cat) => {
    const entries = visible.filter((e) => e.category === cat)
    if (entries.length === 0) return ''
    const cards = entries.map((e) => kbEntryCard(businessId, secret, e)).join('')

    // Entries load oldest-first and the lookup is capped, so anything past the
    // cap in one category never reaches Emma. Say so where the operator can see
    // it — there is no ordering lever left to work around it.
    const activeCount = result.data.filter((e) => e.category === cat && e.active).length
    const overflow =
      activeCount > MAX_ENTRIES_PER_QUERY
        ? `<div class="alert alert-warning">
             Esta categoría tiene ${activeCount} entradas activas y Emma solo carga las
             ${MAX_ENTRIES_PER_QUERY} más antiguas. Las ${activeCount - MAX_ENTRIES_PER_QUERY}
             más nuevas no le llegan — desactivá las que ya no apliquen o juntá varias en una sola entrada.
           </div>`
        : ''

    return `
      <div class="kb-group">
        <div class="kb-group-header">${esc(KB_CATEGORY_LABELS[cat])}</div>
        ${overflow}
        ${cards}
      </div>`
  }).join('')

  // Rows filed under a retired category are excluded from everything Emma reads,
  // but they must stay visible here: hiding them would leave the operator with
  // undeletable rows they cannot even see. Only shown when some actually exist.
  const retired = result.data.filter((e) =>
    (LEGACY_KB_CATEGORIES as readonly string[]).includes(e.category),
  )
  const retiredGroup =
    retired.length > 0 && !activeFilter
      ? `<div class="kb-group">
           <div class="kb-group-header">Categorías retiradas</div>
           <div class="alert alert-warning">
             Estas ${retired.length} ${retired.length === 1 ? 'entrada duplicaba' : 'entradas duplicaban'}
             datos que ahora viven en <a href="/admin/dashboard/${bid}/configure?secret=${se}">Configuración</a>
             (servicios, precios, ubicación, contacto). Emma ya no las lee. Revisá que el dato esté
             en Configuración y borralas.
           </div>
           ${retired.map((e) => kbEntryCard(businessId, secret, e)).join('')}
         </div>`
      : ''

  const emptyState =
    visible.length === 0 && retiredGroup === ''
      ? `<div class="kb-empty">${
          activeFilter
            ? 'No hay entradas en esta categoría.'
            : 'Este negocio todavía no tiene entradas en su base de conocimiento.'
        }</div>`
      : ''

  const newForm = showNew
    ? `<div class="config-section" style="margin-bottom:32px">
         <div class="section-header">
           <h2 class="section-title">Nueva entrada</h2>
           <p class="section-desc">Se guarda desactivable y podés editarla en cualquier momento</p>
         </div>
         ${kbEntryForm(businessId, secret, null, nicheOf(business.settings))}
       </div>`
    : ''

  const toasts = [
    saved ? renderToast('success', 'Cambios guardados', 'La entrada quedó actualizada.', 4000) : '',
    error ? renderToast('error', 'No se pudo guardar', esc(error)) : '',
  ].join('')

  const body = `
    <div class="config-page kb-page">
    <a href="/admin/dashboard/${bid}?secret=${se}" class="back">← ${esc(business.name)}</a>
    <div class="page-header">
      <h1 class="page-title">Base de conocimiento</h1>
      <div class="actions">
        <a href="/admin/dashboard/${bid}/kb?secret=${se}&new=1" class="btn btn-primary">Nueva entrada</a>
      </div>
    </div>
    <div class="toast-stack" role="status" aria-live="polite">${toasts}</div>
    <div class="kb-banner">
      Información complementaria que Emma comparte con los clientes. Los datos básicos
      (servicios, precios, horarios, ubicación y contacto) ya están en
      <a href="/admin/dashboard/${bid}/configure?secret=${se}">Configuración</a>.
    </div>
    ${newForm}
    <div class="kb-filters">${filterLinks}</div>
    ${groups}
    ${emptyState}
    </div>`

  return c.html(layout(`Base de conocimiento — ${business.name}`, body, secret))
})

dashboardRoutes.get('/admin/dashboard/:id/kb/:kbId/edit', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const business = await businessRepo.findById(businessId)
  if (!business) return c.html('<h1>404</h1>', 404) as Response

  const result = await knowledgeBaseService.getById(businessId, c.req.param('kbId'))
  if (!result.ok) {
    return c.html(
      layout('Base de conocimiento', '<p class="muted">Entrada no encontrada.</p>', secret),
      404,
    ) as Response
  }

  const se = encodeURIComponent(secret)
  const bid = esc(businessId)
  const error = c.req.query('error') ? decodeURIComponent(c.req.query('error') ?? '') : null
  const body = `
    <div class="config-page kb-page">
    <a href="/admin/dashboard/${bid}/kb?secret=${se}" class="back">← Base de conocimiento</a>
    <div class="page-header">
      <h1 class="page-title">Editar entrada</h1>
    </div>
    <div class="toast-stack" role="status" aria-live="polite">${
      error ? renderToast('error', 'No se pudo guardar', esc(error)) : ''
    }</div>
    <div class="config-section">
      ${kbEntryForm(businessId, secret, result.data, nicheOf(business.settings))}
    </div>
    </div>`

  return c.html(layout(`Editar entrada — ${business.name}`, body, secret))
})

interface ParsedKbForm {
  title: string | null
  // Narrowed by the KB_CATEGORIES lookup in parseKbForm: the form can only ever
  // produce an active category, never a retired one.
  category: ActiveKbCategory
  content: string
  attachmentType: KbAttachmentType
  attachmentUrl: string | null
  sendMode: KbSendMode
  triggerKeywords: string[]
  active: boolean
}

// Parses the shared KB form. Returns a message instead of throwing so the caller
// can redirect back with it rendered in the error banner.
function parseKbForm(
  formData: FormData,
): { ok: true; data: ParsedKbForm } | { ok: false; message: string } {
  const rawCategory = formData.get('category')?.toString() ?? ''
  const category = KB_CATEGORIES.find((cat) => cat === rawCategory)
  if (!category) return { ok: false, message: 'Categoría inválida.' }

  const content = formData.get('content')?.toString().trim() ?? ''
  if (content.length === 0) return { ok: false, message: 'El contenido no puede estar vacío.' }

  const rawSendMode = formData.get('sendMode')?.toString() ?? 'on_request'
  const sendMode = KB_SEND_MODES.find((mode) => mode === rawSendMode)
  if (!sendMode) return { ok: false, message: 'Modo de envío inválido.' }

  const rawAttachmentType = formData.get('attachmentType')?.toString() ?? 'none'
  const attachmentType = KB_ATTACHMENT_TYPES.find((type) => type === rawAttachmentType)
  if (!attachmentType) return { ok: false, message: 'Tipo de adjunto inválido.' }

  const attachmentUrl = formData.get('attachmentUrl')?.toString().trim() || null
  if (attachmentType !== 'none' && !attachmentUrl) {
    return { ok: false, message: 'Elegiste un tipo de adjunto pero no pusiste la URL.' }
  }

  const triggerKeywords = (formData.get('triggerKeywords')?.toString() ?? '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
  if (sendMode === 'trigger_based' && triggerKeywords.length === 0) {
    return {
      ok: false,
      message: 'El modo "Por palabras clave" necesita al menos una palabra clave.',
    }
  }

  return {
    ok: true,
    data: {
      title: formData.get('title')?.toString().trim() || null,
      category,
      content,
      attachmentType,
      // A stale URL left over from a previous type would otherwise keep being
      // rendered into the prompt.
      attachmentUrl: attachmentType === 'none' ? null : attachmentUrl,
      sendMode,
      triggerKeywords,
      active: formData.get('active')?.toString() !== '0',
    },
  }
}

dashboardRoutes.post('/admin/dashboard/:id/kb', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const se = encodeURIComponent(secret)
  const bid = esc(businessId)

  const business = await businessRepo.findById(businessId)
  if (!business) return c.html('<h1>404</h1>', 404) as Response

  const parsed = parseKbForm(await c.req.formData())
  if (!parsed.ok) {
    return c.redirect(
      `/admin/dashboard/${bid}/kb?secret=${se}&new=1&error=${encodeURIComponent(parsed.message)}`,
      302,
    )
  }

  const result = await knowledgeBaseService.create({ businessId, ...parsed.data })
  if (!result.ok) {
    logger.error({ err: result.error, businessId }, 'dashboard: failed to create KB entry')
    return c.redirect(
      `/admin/dashboard/${bid}/kb?secret=${se}&new=1&error=${encodeURIComponent(result.error.userMessage)}`,
      302,
    )
  }

  return c.redirect(`/admin/dashboard/${bid}/kb?secret=${se}&saved=1`, 302)
})

dashboardRoutes.post('/admin/dashboard/:id/kb/:kbId', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const kbId = c.req.param('kbId')
  const se = encodeURIComponent(secret)
  const bid = esc(businessId)

  const parsed = parseKbForm(await c.req.formData())
  if (!parsed.ok) {
    return c.redirect(
      `/admin/dashboard/${bid}/kb/${encodeURIComponent(kbId)}/edit?secret=${se}&error=${encodeURIComponent(parsed.message)}`,
      302,
    )
  }

  // A blank title on edit keeps the existing one instead of wiping it.
  const { title, ...rest } = parsed.data
  const result = await knowledgeBaseService.update(businessId, kbId, {
    ...rest,
    ...(title ? { title } : {}),
  })
  if (!result.ok) {
    logger.error({ err: result.error, businessId, kbId }, 'dashboard: failed to update KB entry')
    return c.redirect(
      `/admin/dashboard/${bid}/kb?secret=${se}&error=${encodeURIComponent(result.error.userMessage)}`,
      302,
    )
  }

  return c.redirect(`/admin/dashboard/${bid}/kb?secret=${se}&saved=1`, 302)
})

dashboardRoutes.post('/admin/dashboard/:id/kb/:kbId/delete', async (c) => {
  const secret = getSecret(c)
  if (!secret) return unauthorized(c)

  const businessId = c.req.param('id')
  const kbId = c.req.param('kbId')
  const se = encodeURIComponent(secret)
  const bid = esc(businessId)

  const result = await knowledgeBaseService.remove(businessId, kbId)
  if (!result.ok) {
    logger.error({ err: result.error, businessId, kbId }, 'dashboard: failed to delete KB entry')
    return c.redirect(
      `/admin/dashboard/${bid}/kb?secret=${se}&error=${encodeURIComponent(result.error.userMessage)}`,
      302,
    )
  }

  logger.warn({ businessId, kbId }, 'dashboard: knowledge base entry deleted by admin')
  return c.redirect(`/admin/dashboard/${bid}/kb?secret=${se}&saved=1`, 302)
})
