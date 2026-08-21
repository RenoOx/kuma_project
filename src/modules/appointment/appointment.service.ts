import { logger } from '@/config/logger.js'
import { db } from '@/db/client.js'
import type { Appointment, AppointmentStatus, Business } from '@/db/schema/index.js'
import * as businessService from '@/modules/business/business.service.js'
import {
  type BusinessSettings,
  type DayBreak,
  type DayHours,
  dayKeyForJsDow,
  getMinBookingNoticeMinutes,
  type Niche,
  resolveDayHours,
  resolveServiceDurationMinutes,
  type Service,
} from '@/modules/business/business.settings.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import * as eventsRepo from '@/modules/events/events.repo.js'
import * as googleCalendarService from '@/modules/google/googleCalendar.service.js'
import * as messageService from '@/modules/message/message.service.js'
import * as customerNotifier from '@/modules/whatsapp/customerNotifier.js'
import * as ownerNotifier from '@/modules/whatsapp/ownerNotifier.js'
import { formatDateTimeForDisplay } from '@/shared/datetime.js'
import {
  AppError,
  ConflictError,
  NotConnectedError,
  NotFoundError,
  ValidationError,
} from '@/shared/errors.js'
import { formatPersonName } from '@/shared/name.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as appointmentRepo from './appointment.repo.js'

const IDEMPOTENCY_WINDOW_MS = 30_000

export interface CheckAvailabilityResult {
  availableSlots: string[]
  closedReason?: string
  // The grid these slots sit on. Carried out so the caller can tell apart two
  // adjacent slots from two slots with a booking wedged between them, without
  // re-reading settings or guessing the step from the gaps (which misreads a
  // fragmented day as one long free block).
  slotDurationMinutes: number
  // How many otherwise-free slots the lead-time gate removed. The gate used to
  // drop them silently, so a caller seeing an empty morning could not tell
  // "the hour already passed" from "fully booked" from "closed" — and the model
  // filled that gap with the opening hours it reads in the prompt, offering
  // 8:00am at 10:36am. Zero on any future date.
  slotsDroppedByLeadTime: number
  // The lead time actually applied, so the caller can say why.
  minNoticeMinutes: number
}

function normalizeServiceName(s: string): string {
  return s.toLowerCase().trim()
}

// Names arrive typed into a chat, so they carry stray whitespace and the odd
// pasted emoji. Capped because customers.name feeds the reminder pushes, the
// owner's request card and the admin table, where a 500-character "name"
// wrecks the layout.
const MAX_CUSTOMER_NAME_LENGTH = 80

// How far back a photo still counts as "they just paid". Same window as the
// image expectation TTL: long enough to switch to the bank app and back, short
// enough that yesterday's photo does not unlock today's booking.
export const PAYMENT_EVIDENCE_WINDOW_MS = 30 * 60 * 1000

/**
 * Whether this conversation shows a recent sign that the customer sent a
 * payment capture.
 *
 * Deliberately NOT a validation of the payment: Emma cannot see the image, so
 * any recent photo counts. The owner is the one who looks at it and decides.
 * The gate exists to stop Emma from filing a booking with no evidence at all.
 */
export async function hasRecentPaymentEvidence(
  businessId: string,
  conversationId: string,
): Promise<boolean> {
  const since = new Date(Date.now() - PAYMENT_EVIDENCE_WINDOW_MS)
  return eventsRepo.existsSince(businessId, conversationId, 'customer_image_received', since)
}

function normalizeCustomerName(raw: string | undefined): string | null {
  if (!raw) return null
  const cleaned = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_CUSTOMER_NAME_LENGTH)
  return cleaned.length === 0 ? null : cleaned
}

function timeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  if (h === undefined || m === undefined) return Number.NaN
  return h * 60 + m
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

// Day-of-week for a YYYY-MM-DD calendar date. Day-of-week is a property of
// the calendar date itself, so it doesn't depend on the host's timezone — but
// we still need a deterministic parse, so we use UTC math.
function dayKeyForDateISO(dateISO: string): ReturnType<typeof dayKeyForJsDow> {
  const parts = dateISO.split('-').map(Number)
  if (parts.length !== 3) return null
  const [y, m, d] = parts
  if (!y || !m || !d) return null
  return dayKeyForJsDow(new Date(Date.UTC(y, m - 1, d)).getUTCDay())
}

// Resolve the wall-clock offset that `timezone` applies on `dateISO`. Uses
// Intl.DateTimeFormat with longOffset (ES 2022, Node 18+). Returns the offset
// string we can append to a YYYY-MM-DDTHH:mm:ss prefix, eg "-05:00".
function tzOffsetForDate(timezone: string, dateISO: string): string | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    })
    const sample = new Date(`${dateISO}T12:00:00Z`)
    const tzName = formatter.formatToParts(sample).find((p) => p.type === 'timeZoneName')?.value
    if (!tzName) return null
    if (tzName === 'GMT') return '+00:00'
    const offsetRaw = tzName.replace(/^GMT/, '').trim()
    const m = offsetRaw.match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/)
    if (!m) return null
    const sign = m[1] as string
    const hh = (m[2] ?? '00').padStart(2, '0')
    const mm = m[3] ?? '00'
    return `${sign}${hh}:${mm}`
  } catch {
    return null
  }
}

// True iff the interval [slotStart, slotStart + serviceDuration) overlaps the
// break interval [break.start, break.end). Covers both "slot starts inside the
// break" and "slot starts before the break but the service runs into it".
function overlapsBreak(
  slotStartMinutes: number,
  serviceDurationMinutes: number,
  dayBreak: DayBreak,
): boolean {
  const bStart = timeToMinutes(dayBreak.start)
  const bEnd = timeToMinutes(dayBreak.end)
  if (Number.isNaN(bStart) || Number.isNaN(bEnd)) return false
  const slotEnd = slotStartMinutes + serviceDurationMinutes
  return slotStartMinutes < bEnd && slotEnd > bStart
}

// True iff the half-open intervals [aStart, aEnd) and [bStart, bEnd) overlap.
// Touching boundaries do NOT overlap: an appointment ending exactly at 10:00
// leaves 10:00 free. Same rule as overlapsBreak, over instants instead of
// minutes-since-midnight.
function intervalsOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && aEnd > bStart
}

// Time an existing appointment actually occupies, in epoch millis.
//
// Reading only `scheduledAt` is what caused the double-booking bug: a 60-min
// appointment on a 30-min grid marked ONE instant as taken, so the slot it ran
// through stayed on offer. `duration_minutes` is NOT NULL in the schema, so
// every row carries a real length.
interface BusyInterval {
  startMs: number
  endMs: number
}

function toBusyIntervals(rows: Appointment[]): BusyInterval[] {
  return rows.map((a) => {
    const startMs = a.scheduledAt.getTime()
    return { startMs, endMs: startMs + a.durationMinutes * 60_000 }
  })
}

// Longest appointment this business is able to create. Used only to widen the
// lookback window when loading the day's appointments, so one that started
// before midnight and runs into this day still blocks the slots it covers.
function maxAppointmentMinutes(settings: BusinessSettings): number {
  return settings.services.reduce(
    (max, s) => Math.max(max, resolveServiceDurationMinutes(s, settings)),
    settings.slotDurationMinutes,
  )
}

interface BuildSlotsParams {
  dateISO: string
  hours: DayHours & {} // narrowed: non-null
  slotDurationMinutes: number
  serviceDurationMinutes: number
  tzOffset: string
}

function buildSlots(p: BuildSlotsParams): string[] {
  const openMin = timeToMinutes(p.hours.open)
  const closeMin = timeToMinutes(p.hours.close)
  if (Number.isNaN(openMin) || Number.isNaN(closeMin)) return []

  const slots: string[] = []
  for (let m = openMin; m + p.serviceDurationMinutes <= closeMin; m += p.slotDurationMinutes) {
    if (p.hours.break && overlapsBreak(m, p.serviceDurationMinutes, p.hours.break)) {
      continue
    }
    const hh = pad2(Math.floor(m / 60))
    const mm = pad2(m % 60)
    slots.push(`${p.dateISO}T${hh}:${mm}:00${p.tzOffset}`)
  }
  return slots
}

function findKnownService(settings: BusinessSettings, serviceName: string): Service | null {
  const normalized = normalizeServiceName(serviceName)
  return settings.services.find((s) => normalizeServiceName(s.name) === normalized) ?? null
}

function validationErrorForUnknownService(
  businessId: string,
  service: string,
  settings: BusinessSettings,
): ValidationError {
  return new ValidationError({
    message: `unknown service: ${service}`,
    userMessage: `El servicio "${service}" no está en la lista de este negocio.`,
    logContext: {
      businessId,
      service,
      availableServices: settings.services.map((s) => s.name),
    },
  })
}

export async function checkAvailability(
  businessId: string,
  dateISO: string,
  service: string,
): Promise<Result<CheckAvailabilityResult>> {
  try {
    const dayKey = dayKeyForDateISO(dateISO)
    if (!dayKey) {
      return err(
        new AppError({
          code: 'invalid_date',
          message: `cannot parse dateISO: ${dateISO}`,
          userMessage: 'No entendí la fecha. Probá con YYYY-MM-DD.',
          logContext: { dateISO },
        }),
      )
    }

    const businessResult = await businessService.getById(businessId)
    if (!businessResult.ok) return businessResult
    const business = businessResult.data

    const settingsResult = await businessService.getSettings(businessId)
    if (!settingsResult.ok) return settingsResult
    const settings = settingsResult.data

    const knownService = findKnownService(settings, service)
    if (!knownService) {
      return err(validationErrorForUnknownService(businessId, service, settings))
    }

    const dayHours = resolveDayHours(settings, dateISO, dayKey)
    if (dayHours === null) {
      return ok({
        availableSlots: [],
        closedReason: 'cerrado este día',
        slotDurationMinutes: settings.slotDurationMinutes,
        slotsDroppedByLeadTime: 0,
        minNoticeMinutes: getMinBookingNoticeMinutes(settings),
      })
    }

    const tzOffset = tzOffsetForDate(business.timezone, dateISO)
    if (!tzOffset) {
      return err(
        new AppError({
          code: 'invalid_timezone',
          message: `cannot determine offset for ${business.timezone}`,
          userMessage: 'Configuración de timezone inválida.',
          logContext: { businessId, timezone: business.timezone },
        }),
      )
    }

    // Resolved once: the candidate grid and the conflict check must agree on
    // how long the requested service lasts.
    const serviceDurationMinutes = resolveServiceDurationMinutes(knownService, settings)

    const candidates = buildSlots({
      dateISO,
      hours: dayHours,
      slotDurationMinutes: settings.slotDurationMinutes,
      serviceDurationMinutes,
      tzOffset,
    })

    const dayStart = new Date(`${dateISO}T00:00:00${tzOffset}`)
    const dayEnd = new Date(`${dateISO}T23:59:59${tzOffset}`)
    // Look back by the longest appointment this business can create: one that
    // started before midnight and runs into this day still occupies its slots,
    // and filtering on `scheduled_at >= dayStart` alone would never load it.
    const lookbackStart = new Date(dayStart.getTime() - maxAppointmentMinutes(settings) * 60_000)
    const taken = await appointmentRepo.findByBusinessAndDateRange(
      businessId,
      lookbackStart,
      dayEnd,
    )
    // Each existing appointment blocks its WHOLE range, not just its start
    // instant. Comparing starts alone left every slot a long service ran
    // through on offer, which is a double booking waiting to happen.
    const busy = toBusyIntervals(taken)
    const serviceDurationMs = serviceDurationMinutes * 60_000

    // Drop slots whose start is in the past OR closer to now than the
    // business's required lead time. Reads `Date.now()` so vitest's fake
    // timer can override it deterministically in tests.
    const minNoticeMinutes = getMinBookingNoticeMinutes(settings)
    const earliestAcceptable = Date.now() + minNoticeMinutes * 60_000

    // Split in two on purpose: the difference between these two lists is what
    // the lead-time gate removed, and that count is the only way a caller can
    // distinguish "today is over" from "fully booked".
    const freeSlots = candidates.filter((iso) => {
      const startMs = new Date(iso).getTime()
      const endMs = startMs + serviceDurationMs
      return !busy.some((b) => intervalsOverlap(startMs, endMs, b.startMs, b.endMs))
    })
    const availableSlots = freeSlots.filter((iso) => new Date(iso).getTime() >= earliestAcceptable)
    return ok({
      availableSlots,
      slotDurationMinutes: settings.slotDurationMinutes,
      slotsDroppedByLeadTime: freeSlots.length - availableSlots.length,
      minNoticeMinutes,
    })
  } catch (cause) {
    return err(
      new AppError({
        code: 'check_availability_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude consultar disponibilidad en este momento.',
        logContext: { businessId, dateISO, service },
        cause,
      }),
    )
  }
}

export interface BookAppointmentParams {
  businessId: string
  customerId: string
  service: string
  datetimeISO: string
  // The name the customer gave Emma in the conversation. Optional here because
  // the constraint belongs at the LLM boundary — the book_appointment tool
  // declares it required, and the executor rejects placeholder names before
  // this is ever reached.
  customerName?: string
}

export async function bookAppointment(params: BookAppointmentParams): Promise<Result<Appointment>> {
  try {
    const datetime = new Date(params.datetimeISO)
    if (Number.isNaN(datetime.getTime())) {
      return err(
        new AppError({
          code: 'invalid_datetime',
          message: `cannot parse datetimeISO: ${params.datetimeISO}`,
          userMessage: 'No entendí la fecha y hora.',
          logContext: { datetimeISO: params.datetimeISO },
        }),
      )
    }

    const businessResult = await businessService.getById(params.businessId)
    if (!businessResult.ok) return businessResult
    const business = businessResult.data

    const settingsResult = await businessService.getSettings(params.businessId)
    if (!settingsResult.ok) return settingsResult
    const settings = settingsResult.data

    const knownService = findKnownService(settings, params.service)
    if (!knownService) {
      return err(validationErrorForUnknownService(params.businessId, params.service, settings))
    }

    // Project the requested datetime back into the business's wall-clock to
    // figure out which day-of-week it belongs to, and whether the slot would
    // collide with the configured break.
    const tzDateISO = formatDateInTimezone(datetime, business.timezone)
    const tzWallTimeMin = wallClockMinutesInTimezone(datetime, business.timezone)
    if (tzDateISO === null || tzWallTimeMin === null) {
      return err(
        new AppError({
          code: 'invalid_timezone',
          message: `cannot project ${params.datetimeISO} into ${business.timezone}`,
          userMessage: 'Configuración de timezone inválida.',
          logContext: {
            businessId: params.businessId,
            timezone: business.timezone,
          },
        }),
      )
    }

    const dayKey = dayKeyForDateISO(tzDateISO)
    if (!dayKey) {
      return err(
        new AppError({
          code: 'invalid_date',
          message: `cannot derive day key from ${tzDateISO}`,
          userMessage: 'Configuración de fecha inválida.',
          logContext: { tzDateISO },
        }),
      )
    }
    const dayHours = resolveDayHours(settings, tzDateISO, dayKey)
    if (dayHours === null) {
      return err(
        new ValidationError({
          message: 'business closed on this day',
          userMessage: 'El negocio no atiende ese día.',
          logContext: {
            businessId: params.businessId,
            datetimeISO: params.datetimeISO,
            dayKey,
          },
        }),
      )
    }
    // Resolved once here: the break check, the persisted appointment and the
    // Google event must all agree on how long this booking lasts.
    const serviceDurationMinutes = resolveServiceDurationMinutes(knownService, settings)

    if (dayHours.break && overlapsBreak(tzWallTimeMin, serviceDurationMinutes, dayHours.break)) {
      return err(
        new ValidationError({
          message: 'requested slot overlaps the configured break',
          userMessage:
            'Ese horario coincide con el descanso del negocio. Por favor elegí otro slot.',
          logContext: {
            businessId: params.businessId,
            datetimeISO: params.datetimeISO,
            break: dayHours.break,
            serviceDurationMinutes,
          },
        }),
      )
    }

    // Lead-time check: refuse slots in the past or under the required notice.
    // Comes after structural validations (day open + break) so the model gets
    // the most informative error in each case, but before idempotency so we
    // never persist a too-soon booking.
    const minNoticeMinutes = getMinBookingNoticeMinutes(settings)
    const earliestAcceptable = Date.now() + minNoticeMinutes * 60_000
    if (datetime.getTime() < earliestAcceptable) {
      return err(
        new ValidationError({
          code: 'slot_too_soon',
          message: 'requested slot is in the past or under the minimum lead time',
          userMessage: `Ese horario ya pasó o está muy próximo. Necesito al menos ${minNoticeMinutes} minutos de anticipación.`,
          logContext: {
            businessId: params.businessId,
            datetimeISO: params.datetimeISO,
            minNoticeMinutes,
            nowISO: new Date().toISOString(),
          },
        }),
      )
    }

    // Idempotency: same (customer, slot, service) booked in last 30s wins.
    //
    // MUST stay ahead of the overlap check below: a retry of a booking we
    // already persisted overlaps its own appointment, so checking conflicts
    // first would turn every duplicate delivery into a ConflictError.
    const recent = await appointmentRepo.findRecentByCustomerSlot(
      params.businessId,
      params.customerId,
      datetime,
      params.service,
      IDEMPOTENCY_WINDOW_MS,
    )
    if (recent) {
      logger.info(
        { businessId: params.businessId, appointmentId: recent.id },
        'bookAppointment: idempotent hit, returning existing appointment',
      )
      return ok(recent)
    }

    // The whole span the new appointment would occupy has to be free, not just
    // its starting instant: booking a 60-min service at 10:00 must fail when
    // something already sits at 10:30.
    const requestedEnd = new Date(datetime.getTime() + serviceDurationMinutes * 60_000)
    const existing = await appointmentRepo.findOverlapping(
      params.businessId,
      datetime,
      requestedEnd,
    )
    if (existing) {
      return err(
        new ConflictError({
          message: 'requested interval overlaps an existing appointment',
          userMessage: 'Ese horario se cruza con otra cita ya reservada, elegí otro.',
          logContext: {
            businessId: params.businessId,
            datetimeISO: params.datetimeISO,
            requestedEndISO: requestedEnd.toISOString(),
            serviceDurationMinutes,
            existingAppointmentId: existing.id,
            existingScheduledAtISO: existing.scheduledAt.toISOString(),
            existingDurationMinutes: existing.durationMinutes,
          },
        }),
      )
    }

    // Businesses on `requires_approval` never get a confirmed booking out of
    // Emma: the row lands as `pending` and a human promotes it. Decided here,
    // at the insert, so the appointment is never briefly visible as scheduled.
    const requiresApproval = settings.bookingMode === 'requires_approval'

    // The push name WhatsApp hands us is whatever the customer set on their own
    // profile — "Bebé 💕", a single initial, or nothing at all. Emma now asks
    // for the real name before booking, and this is where it replaces the push
    // name for good: every later reminder, owner card and admin row reads it.
    //
    // Runs BEFORE the insert on purpose. After it, a failed write would return
    // an error with the appointment already persisted.
    let customer = await customerRepo.findById(params.businessId, params.customerId)
    const providedName = normalizeCustomerName(params.customerName)
    if (providedName && customer && customer.name?.trim() !== providedName) {
      const renamed = await customerRepo.updateName(
        params.businessId,
        params.customerId,
        providedName,
      )
      if (renamed) customer = renamed
    }

    const created = await appointmentRepo.create({
      businessId: params.businessId,
      customerId: params.customerId,
      service: params.service,
      scheduledAt: datetime,
      durationMinutes: serviceDurationMinutes,
      status: requiresApproval ? 'pending' : 'scheduled',
    })

    // A pending request is NOT a commitment, so it does not reach the calendar
    // yet: the owner would see a booking they never approved sitting next to
    // their real ones. confirmAppointment mirrors it once they say yes.
    if (requiresApproval) {
      // Fire-and-forget: the customer is still waiting on Emma's reply, and the
      // request is already persisted. Failures are warn-logged in the helper.
      notifyOwnerOfPendingRequest({
        businessId: params.businessId,
        niche: settings.niche,
        service: params.service,
        scheduledAt: datetime,
        timezone: business.timezone,
        customer,
      }).catch((err) => {
        logger.warn(
          { err, businessId: params.businessId, appointmentId: created.id },
          'notifyOwnerOfPendingRequest rejected unexpectedly',
        )
      })
      return ok(created)
    }

    // Best-effort Google Calendar sync. By contract this NEVER fails the book:
    // the local appointment is authoritative; the calendar event is a
    // nice-to-have mirror. Three branches:
    //   - createEvent ok → patch appointment with googleEventId
    //   - NotConnectedError → expected when the business hasn't linked Google yet
    //   - any other failure → log error, keep googleEventId null
    const googleEventId = await mirrorToGoogleCalendar({
      businessId: params.businessId,
      appointment: created,
      timezone: business.timezone,
      customer,
    })
    if (googleEventId === null) return ok(created)

    return ok(await appointmentRepo.update(params.businessId, created.id, { googleEventId }))
  } catch (cause) {
    return err(
      new AppError({
        code: 'book_appointment_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude agendar la cita en este momento.',
        logContext: {
          businessId: params.businessId,
          customerId: params.customerId,
          datetimeISO: params.datetimeISO,
          service: params.service,
        },
        cause,
      }),
    )
  }
}

// Returns the YYYY-MM-DD that `instant` represents in `timezone`, or null
// if the formatter can't handle the timezone.
function formatDateInTimezone(instant: Date, timezone: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(instant)
  } catch {
    return null
  }
}

// Wall-clock minutes (hours*60 + minutes) of `instant` in `timezone`.
function wallClockMinutesInTimezone(instant: Date, timezone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(instant)
    const hour = parts.find((p) => p.type === 'hour')?.value
    const minute = parts.find((p) => p.type === 'minute')?.value
    if (hour === undefined || minute === undefined) return null
    const h = Number(hour)
    const m = Number(minute)
    if (Number.isNaN(h) || Number.isNaN(m)) return null
    // Intl gives '24:00' for midnight in some locales; normalize.
    return (h === 24 ? 0 : h) * 60 + m
  } catch {
    return null
  }
}

// ── Espejo en Google Calendar ────────────────────────────────────────────────
//
// Best-effort by contract: the local appointment is authoritative and the
// calendar event is a mirror, so neither helper below ever fails its caller.

interface CustomerContact {
  name: string | null
  phone: string
}

/** Creates the calendar event. Returns its id, or null when it didn't happen. */
async function mirrorToGoogleCalendar(params: {
  businessId: string
  appointment: Appointment
  timezone: string
  customer: CustomerContact | null
}): Promise<string | null> {
  const { businessId, appointment, customer } = params
  const customerLabel = customer?.name?.trim() || customer?.phone || appointment.customerId

  const result = await googleCalendarService.createEvent({
    businessId,
    summary: `Cita: ${appointment.service} - ${customerLabel}`,
    description: `Cliente: ${customer?.phone ?? '(sin teléfono)'}\nAgendado vía Kuma (WhatsApp)`,
    startDateTime: appointment.scheduledAt,
    durationMinutes: appointment.durationMinutes,
    timezone: params.timezone,
  })

  if (result.ok) {
    logger.info(
      {
        businessId,
        appointmentId: appointment.id,
        googleEventId: result.data.googleEventId,
        htmlLink: result.data.htmlLink,
      },
      'appointment mirrored to google calendar',
    )
    return result.data.googleEventId
  }

  if (result.error instanceof NotConnectedError) {
    logger.warn(
      { businessId, appointmentId: appointment.id },
      'business has no google calendar connected, appointment saved locally only',
    )
  } else {
    logger.error(
      {
        businessId,
        appointmentId: appointment.id,
        code: result.error.code,
        context: result.error.logContext,
      },
      'google calendar sync failed, appointment saved locally only',
    )
  }
  return null
}

/**
 * Drops the calendar event of an appointment that no longer stands.
 *
 * Without this, an appointment the owner cancelled from WhatsApp kept occupying
 * their Google Calendar forever — the panel deleted the event, the WhatsApp flow
 * did not, and the two views of the same day drifted apart.
 */
async function removeGoogleMirror(businessId: string, appointment: Appointment): Promise<void> {
  if (!appointment.googleEventId) return

  const result = await googleCalendarService.cancelEvent(businessId, appointment.googleEventId)
  if (result.ok) {
    logger.info(
      { businessId, appointmentId: appointment.id, googleEventId: appointment.googleEventId },
      'google calendar event removed for cancelled appointment',
    )
    return
  }
  logger.warn(
    {
      businessId,
      appointmentId: appointment.id,
      googleEventId: appointment.googleEventId,
      code: result.error.code,
    },
    'could not remove google calendar event; the local appointment is cancelled anyway',
  )
}

// Only the service line changes across verticals — the rest of the card reads
// the same everywhere. A dental request marked with 💈 would look careless to
// the one person who reads these.
const NICHE_SERVICE_EMOJI: Record<Niche, string> = {
  dental: '🦷',
  barberia: '💈',
  estetica: '💅',
  salud: '🩺',
  general: '💼',
}

// Used in the owner's request card and in every patient-facing notice
// (confirmed / rejected / rescheduled / cancelled). Was rendering 24h, so a
// patient was told their appointment was at "19:00".
const formatRequestDateTime = formatDateTimeForDisplay

// Push the owner gets when a booking lands as `pending` and needs their call.
// Best-effort by the same rule as the escalation push: the appointment is
// already persisted, and the customer waiting on a reply must not be held up by
// an outbound send.
async function notifyOwnerOfPendingRequest(params: {
  businessId: string
  niche: Niche
  service: string
  scheduledAt: Date
  timezone: string
  customer: { name: string | null; phone: string } | null
}): Promise<void> {
  const who = formatPersonName(params.customer?.name) ?? '(sin nombre)'
  const phone = params.customer?.phone ?? '(sin teléfono)'

  const text = [
    '📋 *Nueva solicitud de cita*',
    '',
    `👤 ${who}`,
    `📱 ${phone}`,
    `${NICHE_SERVICE_EMOJI[params.niche]} ${params.service}`,
    `📅 ${formatRequestDateTime(params.scheduledAt, params.timezone)}`,
    '',
    'Responde para confirmar o gestionar.',
  ].join('\n')

  const sent = await ownerNotifier.notifyOwner(params.businessId, text)
  if (!sent.ok) {
    logger.warn(
      { businessId: params.businessId, code: sent.error.code },
      'owner notification of pending booking request failed (silenced) — the request is persisted but nobody was told',
    )
  }
}

export interface EscalateParams {
  businessId: string
  conversationId: string
  reason: string
}

// Build the push text the owner sees in WhatsApp and dispatch via the
// notifier. Best-effort: any failure here is logged and silenced — the
// escalation itself is already persisted by the time this runs.
async function notifyOwnerOfEscalation(params: EscalateParams): Promise<void> {
  const conv = await conversationRepo.findById(params.businessId, params.conversationId)
  if (!conv || !conv.customerId) return
  const customer = await customerRepo.findById(params.businessId, conv.customerId)
  if (!customer) return

  // `?.trim()` alone yields undefined for a nameless customer, which the
  // template below rendered literally as "Cliente: undefined". Escalations fire
  // for people who never booked, so a missing name is normal here — say so.
  const who = formatPersonName(customer.name) ?? '(sin nombre)'
  const phone = customer.phone ? `(${customer.phone})` : null
  const text = [
    '🔔 *Escalación pendiente*',
    `Cliente: ${who}` + (phone ? ` ${phone}` : ''),
    `Motivo: ${params.reason}`,
    'Revisá la conversación cuando puedas.',
  ].join('\n')

  const sent = await ownerNotifier.notifyOwner(params.businessId, text)
  if (!sent.ok) {
    logger.warn(
      {
        businessId: params.businessId,
        conversationId: params.conversationId,
        code: sent.error.code,
      },
      'owner notification of escalation failed (silenced)',
    )
  }
}

export async function escalate(params: EscalateParams): Promise<Result<void>> {
  try {
    const escalateResult = await conversationService.escalate(
      params.businessId,
      params.conversationId,
    )
    if (!escalateResult.ok) return escalateResult

    await eventsRepo.create({
      businessId: params.businessId,
      conversationId: params.conversationId,
      type: 'escalation',
      payload: { reason: params.reason },
    })

    logger.warn(
      {
        businessId: params.businessId,
        conversationId: params.conversationId,
        reason: params.reason,
      },
      'conversation escalated to human',
    )

    // Fire-and-forget owner notification. We don't await it because the
    // caller (LLM tool loop) shouldn't be blocked by a WhatsApp send; the
    // local escalation is authoritative. Failures are warn-logged.
    notifyOwnerOfEscalation(params).catch((err) => {
      logger.warn(
        {
          err,
          businessId: params.businessId,
          conversationId: params.conversationId,
        },
        'notifyOwnerOfEscalation rejected unexpectedly',
      )
    })

    return ok(undefined)
  } catch (cause) {
    return err(
      new AppError({
        code: 'escalate_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude derivar a un humano en este momento.',
        logContext: {
          businessId: params.businessId,
          conversationId: params.conversationId,
        },
        cause,
      }),
    )
  }
}

// ── Gestión de solicitudes por parte del dueño ───────────────────────────────
//
// The owner drives these from their own WhatsApp thread (see ownerAssistant).
// Every one of them validates that the appointment belongs to THIS business,
// validates the status transition, keeps Google Calendar in step, and tells the
// patient what happened.
//
// The patient notification is AWAITED rather than fire-and-forget, unlike the
// escalation push. The owner is waiting on a reply that claims "listo, le avisé
// al paciente" — reporting that without knowing whether it left would make Emma
// lie about the one thing the owner is relying on.

/**
 * Marker written on the `pending` row that a reschedule creates.
 *
 * Two different flows produce a `pending` appointment, and the row alone cannot
 * say which party still has to agree:
 *   - bookingMode 'requires_approval' → the PATIENT filed a request that waits
 *     on the owner's call.
 *   - rescheduleAppointment → the OWNER proposed a slot that waits on the
 *     patient's answer.
 *
 * Only the second one may be confirmed by the patient saying "dale". Without
 * this marker, a patient answering "perfecto" to their own submitted request
 * would self-approve it and defeat `requires_approval` entirely.
 *
 * Stored in the `notes` column, which no code path was using — so this needs no
 * migration. Rows created before the marker existed read as null, i.e. still
 * awaiting the owner, which is the safe side to fail on.
 */
export const OWNER_PROPOSED_NOTE = 'owner_proposed_slot'

const STATUS_LABELS: Record<AppointmentStatus, string> = {
  pending: 'pendiente de aprobación',
  scheduled: 'agendada',
  confirmed: 'confirmada',
  cancelled: 'cancelada',
  completed: 'completada',
}

interface AppointmentContext {
  appointment: Appointment
  business: Business
  customer: CustomerContact & { id: string }
}

// Loads everything the transitions below need, with the tenant check built in:
// findById filters by businessId, so another business's id simply comes back
// empty instead of leaking a row.
async function loadAppointmentContext(
  businessId: string,
  appointmentId: string,
): Promise<Result<AppointmentContext>> {
  const appointment = await appointmentRepo.findById(businessId, appointmentId)
  if (!appointment) {
    return err(
      new NotFoundError({
        resource: 'appointment',
        userMessage: 'No encontré esa cita en este negocio.',
        logContext: { businessId, appointmentId },
      }),
    )
  }

  const businessResult = await businessService.getById(businessId)
  if (!businessResult.ok) return businessResult

  const customer = await customerRepo.findById(businessId, appointment.customerId)
  if (!customer) {
    return err(
      new NotFoundError({
        resource: 'customer',
        userMessage: 'No encontré al cliente de esa cita.',
        logContext: { businessId, appointmentId, customerId: appointment.customerId },
      }),
    )
  }

  return ok({
    appointment,
    business: businessResult.data,
    customer: { id: customer.id, name: customer.name, phone: customer.phone },
  })
}

function wrongStatus(
  action: string,
  businessId: string,
  appointment: Appointment,
): ValidationError {
  return new ValidationError({
    code: 'invalid_status_transition',
    message: `cannot ${action} an appointment in status ${appointment.status}`,
    userMessage: `Esa cita está ${STATUS_LABELS[appointment.status]}, no se puede ${action}.`,
    logContext: {
      businessId,
      appointmentId: appointment.id,
      currentStatus: appointment.status,
    },
  })
}

/**
 * Delivers a message to the patient AND records it in their conversation.
 *
 * The transcript entry is not bookkeeping: without it the patient answers
 * "gracias, ahí estaré" to a message Emma has no memory of sending, and her
 * next reply reads as a non sequitur.
 */
async function messagePatient(params: {
  businessId: string
  customerId: string
  phone: string
  text: string
}): Promise<Result<void>> {
  const conversation = await conversationService.getOrCreateOpen(
    params.businessId,
    params.customerId,
  )
  if (conversation.ok) {
    const persisted = await messageService.append({
      businessId: params.businessId,
      conversationId: conversation.data.id,
      role: 'assistant',
      content: params.text,
    })
    if (!persisted.ok) {
      logger.warn(
        { businessId: params.businessId, code: persisted.error.code },
        'could not record the patient notification in the transcript',
      )
    }
  }

  return customerNotifier.notifyCustomer(params.businessId, params.phone, params.text)
}

// Same shape as the reminder greeting, so a patient who gets a 24h reminder and
// then a confirmation hears one consistent voice. No name on file → a bare
// "¡Hola!", never "¡Hola null!" or a dangling space.
function patientGreeting(customer: { name: string | null }): string {
  const name = formatPersonName(customer.name)
  return name ? `¡Hola ${name}!` : '¡Hola!'
}

// "El doctor" only fits a clinic. Anywhere else it reads as a stock template
// nobody bothered to adapt.
function proposerLabel(niche: Niche): string {
  return niche === 'dental' || niche === 'salud' ? 'El doctor te propone' : 'Te proponemos'
}

async function nicheOf(businessId: string): Promise<Niche> {
  const settings = await businessService.getSettings(businessId)
  return settings.ok ? settings.data.niche : 'general'
}

export interface PendingAppointmentSummary {
  id: string
  service: string
  scheduledAt: Date
  customerName: string | null
  customerPhone: string
}

export async function listPendingAppointments(
  businessId: string,
): Promise<Result<PendingAppointmentSummary[]>> {
  try {
    const rows = await appointmentRepo.findPendingByBusiness(businessId)
    return ok(
      rows.map((r) => ({
        id: r.id,
        service: r.service,
        scheduledAt: r.scheduledAt,
        customerName: r.customerName,
        customerPhone: r.customerPhone,
      })),
    )
  } catch (cause) {
    return err(
      new AppError({
        code: 'list_pending_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude leer las solicitudes pendientes.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}

export interface AppointmentActionResult {
  appointment: Appointment
  /** False when the status changed but the patient could not be reached. */
  patientNotified: boolean
  patientNotifyError?: string
}

function actionResult(appointment: Appointment, notified: Result<void>): AppointmentActionResult {
  return {
    appointment,
    patientNotified: notified.ok,
    ...(notified.ok ? {} : { patientNotifyError: notified.error.userMessage }),
  }
}

export async function confirmAppointment(params: {
  businessId: string
  appointmentId: string
}): Promise<Result<AppointmentActionResult>> {
  try {
    const ctx = await loadAppointmentContext(params.businessId, params.appointmentId)
    if (!ctx.ok) return ctx
    const { appointment, business, customer } = ctx.data

    if (appointment.status !== 'pending') {
      return err(wrongStatus('confirmar', params.businessId, appointment))
    }

    let updated = await appointmentRepo.update(params.businessId, appointment.id, {
      status: 'scheduled',
    })

    // Now it IS a commitment, so it earns its place on the calendar.
    const googleEventId = await mirrorToGoogleCalendar({
      businessId: params.businessId,
      appointment: updated,
      timezone: business.timezone,
      customer,
    })
    if (googleEventId !== null) {
      updated = await appointmentRepo.update(params.businessId, appointment.id, {
        googleEventId,
      })
    }

    const niche = await nicheOf(params.businessId)
    const text = [
      `${patientGreeting(customer)} Tu cita ha sido confirmada 📋`,
      '',
      `${NICHE_SERVICE_EMOJI[niche]} ${appointment.service}`,
      `📅 ${formatRequestDateTime(appointment.scheduledAt, business.timezone)}`,
      '',
      'Te esperamos. Si necesitas reprogramar, escríbenos con anticipación.',
    ].join('\n')

    const notified = await messagePatient({
      businessId: params.businessId,
      customerId: customer.id,
      phone: customer.phone,
      text,
    })

    logger.info(
      { businessId: params.businessId, appointmentId: appointment.id },
      'owner confirmed a pending appointment',
    )
    return ok(actionResult(updated, notified))
  } catch (cause) {
    return err(
      new AppError({
        code: 'confirm_appointment_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude confirmar la cita en este momento.',
        logContext: {
          businessId: params.businessId,
          appointmentId: params.appointmentId,
        },
        cause,
      }),
    )
  }
}

export async function rejectAppointment(params: {
  businessId: string
  appointmentId: string
  reason?: string
}): Promise<Result<AppointmentActionResult>> {
  try {
    const ctx = await loadAppointmentContext(params.businessId, params.appointmentId)
    if (!ctx.ok) return ctx
    const { appointment, business, customer } = ctx.data

    if (appointment.status !== 'pending') {
      return err(wrongStatus('rechazar', params.businessId, appointment))
    }

    const updated = await appointmentRepo.update(params.businessId, appointment.id, {
      status: 'cancelled',
    })
    await removeGoogleMirror(params.businessId, appointment)

    const reason = params.reason?.trim()
    const text = [
      `${patientGreeting(customer)} Lamentamos informarte que no pudimos confirmar tu cita para ${appointment.service} el ${formatRequestDateTime(appointment.scheduledAt, business.timezone)}.`,
      ...(reason ? [reason] : []),
      '¿Te gustaría agendar en otro horario?',
    ].join(' ')

    const notified = await messagePatient({
      businessId: params.businessId,
      customerId: customer.id,
      phone: customer.phone,
      text,
    })

    logger.info(
      { businessId: params.businessId, appointmentId: appointment.id, reason },
      'owner rejected a pending appointment',
    )
    return ok(actionResult(updated, notified))
  } catch (cause) {
    return err(
      new AppError({
        code: 'reject_appointment_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude rechazar la cita en este momento.',
        logContext: {
          businessId: params.businessId,
          appointmentId: params.appointmentId,
        },
        cause,
      }),
    )
  }
}

export interface RescheduleResult extends AppointmentActionResult {
  /** The fresh `pending` request holding the newly proposed slot. */
  replacement: Appointment
}

export async function rescheduleAppointment(params: {
  businessId: string
  appointmentId: string
  suggestedDatetimeISO: string
  message?: string
}): Promise<Result<RescheduleResult>> {
  try {
    const ctx = await loadAppointmentContext(params.businessId, params.appointmentId)
    if (!ctx.ok) return ctx
    const { appointment, business, customer } = ctx.data

    // A finished or already-dropped appointment has nothing left to move.
    if (appointment.status === 'cancelled' || appointment.status === 'completed') {
      return err(wrongStatus('reprogramar', params.businessId, appointment))
    }

    const datetime = new Date(params.suggestedDatetimeISO)
    if (Number.isNaN(datetime.getTime())) {
      return err(
        new ValidationError({
          message: `cannot parse suggestedDatetimeISO: ${params.suggestedDatetimeISO}`,
          userMessage: 'No entendí la fecha y hora que propusiste.',
          logContext: {
            businessId: params.businessId,
            suggestedDatetimeISO: params.suggestedDatetimeISO,
          },
        }),
      )
    }

    // Opening hours, breaks and lead time are deliberately NOT enforced here:
    // the owner is picking the slot by hand and may well want to squeeze someone
    // into their lunch break. Double-booking is another matter — that is a real
    // clash between two patients, so it still blocks.
    const requestedEnd = new Date(datetime.getTime() + appointment.durationMinutes * 60_000)
    const clash = await appointmentRepo.findOverlapping(params.businessId, datetime, requestedEnd)
    if (clash && clash.id !== appointment.id) {
      return err(
        new ConflictError({
          message: 'suggested slot overlaps an existing appointment',
          userMessage: 'Ese horario se cruza con otra cita ya reservada.',
          logContext: {
            businessId: params.businessId,
            appointmentId: appointment.id,
            suggestedDatetimeISO: params.suggestedDatetimeISO,
            clashingAppointmentId: clash.id,
          },
        }),
      )
    }

    // One transaction: a cancelled original with no replacement would silently
    // drop the patient's request altogether.
    const { original, replacement } = await db.transaction(async (tx) => {
      const original = await appointmentRepo.update(
        params.businessId,
        appointment.id,
        { status: 'cancelled' },
        tx,
      )
      const replacement = await appointmentRepo.create(
        {
          businessId: params.businessId,
          customerId: appointment.customerId,
          service: appointment.service,
          scheduledAt: datetime,
          durationMinutes: appointment.durationMinutes,
          status: 'pending',
          // Records that this slot came FROM the owner, so the patient's "dale"
          // is allowed to confirm it. See OWNER_PROPOSED_NOTE.
          notes: OWNER_PROPOSED_NOTE,
        },
        tx,
      )
      return { original, replacement }
    })

    // The old slot is free again, so its calendar event has to go. The
    // replacement is `pending` and earns an event only once it is confirmed.
    await removeGoogleMirror(params.businessId, appointment)

    const niche = await nicheOf(params.businessId)
    const note = params.message?.trim()
    const text = [
      `${patientGreeting(customer)} ${proposerLabel(niche)} un cambio de horario para tu ${appointment.service}:`,
      '',
      `📅 ${formatRequestDateTime(datetime, business.timezone)}`,
      ...(note ? [note] : []),
      '',
      'Escríbenos para confirmar o elegir otro horario.',
    ].join('\n')

    const notified = await messagePatient({
      businessId: params.businessId,
      customerId: customer.id,
      phone: customer.phone,
      text,
    })

    logger.info(
      {
        businessId: params.businessId,
        appointmentId: appointment.id,
        replacementId: replacement.id,
        suggestedDatetimeISO: params.suggestedDatetimeISO,
      },
      'owner proposed a new slot for an appointment',
    )
    return ok({ ...actionResult(original, notified), replacement })
  } catch (cause) {
    return err(
      new AppError({
        code: 'reschedule_appointment_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude reprogramar la cita en este momento.',
        logContext: {
          businessId: params.businessId,
          appointmentId: params.appointmentId,
        },
        cause,
      }),
    )
  }
}

// ── Confirmación por parte del paciente ──────────────────────────────────────
//
// The mirror image of confirmAppointment above. There, the owner accepts a
// request the patient filed; here, the patient accepts a slot the owner
// proposed, and the push runs the other way — to the owner.
//
// Emma is the only channel between the two: the patient never learns that a
// message went to the doctor, and the doctor never writes into the patient's
// chat. That is why nothing in the tool result below mentions a notification.

/**
 * What the customer still has open, in the shape the system prompt needs.
 *
 * The proposal text already sits in the transcript, but a past assistant turn
 * is something the model *describes* ("te habíamos propuesto...") rather than
 * something it acts on. This is the structured signal that makes it act.
 */
export interface PendingAppointmentContext {
  service: string
  /** Ready to speak, in the business timezone: "martes 19 de agosto, 3:00pm". */
  scheduledAtDisplay: string
  /**
   * True when the owner proposed this slot and the patient still owes an
   * answer — the only case Emma may offer to confirm. False means the patient
   * filed the request and the OWNER owes the answer. See OWNER_PROPOSED_NOTE.
   */
  proposedByOwner: boolean
}

// Read on every inbound customer message, so it stays a single indexed lookup
// (appointments_customer_id_idx) plus the business read the caller already did.
export async function getPendingContextForCustomer(
  businessId: string,
  customerId: string,
  timezone: string,
): Promise<Result<PendingAppointmentContext | null>> {
  try {
    const pending = await appointmentRepo.findLatestPendingByCustomer(businessId, customerId)
    if (!pending) return ok(null)
    return ok({
      service: pending.service,
      scheduledAtDisplay: formatRequestDateTime(pending.scheduledAt, timezone),
      proposedByOwner: pending.notes === OWNER_PROPOSED_NOTE,
    })
  } catch (cause) {
    return err(
      new AppError({
        code: 'pending_context_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude leer tus citas pendientes.',
        logContext: { businessId, customerId },
        cause,
      }),
    )
  }
}

export interface ConfirmPendingResult {
  appointment: Appointment
  /** Ready to speak, in the business timezone: "martes 19 de agosto, 3:00pm". */
  scheduledAtDisplay: string
}

// Card the owner gets the moment a patient accepts. Best-effort, on the same
// rule as the other two owner pushes fired from the customer path: the patient
// is waiting on Emma's reply and must not be held up by an outbound send.
async function notifyOwnerOfPatientConfirmation(params: {
  businessId: string
  niche: Niche
  service: string
  scheduledAt: Date
  timezone: string
  customer: CustomerContact
}): Promise<void> {
  const who = formatPersonName(params.customer.name) ?? '(sin nombre)'

  const text = [
    '✅ *Cita confirmada*',
    '',
    `👤 ${who} aceptó el nuevo horario`,
    // Carried so the owner can answer with reply_to_customer straight off this
    // card, the same way the pending-request card works.
    `📱 ${params.customer.phone}`,
    `${NICHE_SERVICE_EMOJI[params.niche]} ${params.service}`,
    `📅 ${formatRequestDateTime(params.scheduledAt, params.timezone)}`,
  ].join('\n')

  const sent = await ownerNotifier.notifyOwner(params.businessId, text)
  if (!sent.ok) {
    logger.warn(
      { businessId: params.businessId, code: sent.error.code },
      'owner notification of patient confirmation failed (silenced) — the appointment is scheduled but nobody was told',
    )
  }
}

export async function confirmPendingForCustomer(params: {
  businessId: string
  customerId: string
}): Promise<Result<ConfirmPendingResult>> {
  try {
    const pending = await appointmentRepo.findLatestPendingByCustomer(
      params.businessId,
      params.customerId,
    )
    if (!pending) {
      return err(
        new AppError({
          code: 'no_pending_appointment',
          message: 'customer has no pending appointment to confirm',
          userMessage: 'No tenés ninguna solicitud de cita pendiente.',
          logContext: { businessId: params.businessId, customerId: params.customerId },
        }),
      )
    }

    // The patient may only accept what the owner offered. A request the patient
    // filed themselves is still waiting on the owner and stays untouched.
    if (pending.notes !== OWNER_PROPOSED_NOTE) {
      return err(
        new AppError({
          code: 'awaiting_owner_approval',
          message: 'pending appointment was filed by the patient, not proposed by the owner',
          userMessage: 'Tu solicitud sigue en revisión.',
          logContext: {
            businessId: params.businessId,
            customerId: params.customerId,
            appointmentId: pending.id,
          },
        }),
      )
    }

    const ctx = await loadAppointmentContext(params.businessId, pending.id)
    if (!ctx.ok) return ctx
    const { appointment, business, customer } = ctx.data

    // Re-read rather than trusting the row selected above: the owner may have
    // cancelled or confirmed the proposal in between.
    if (appointment.status !== 'pending') {
      return err(wrongStatus('confirmar', params.businessId, appointment))
    }

    let updated = await appointmentRepo.update(params.businessId, appointment.id, {
      status: 'scheduled',
    })

    // Same rule as the owner's confirmAppointment: a `pending` row is not a
    // commitment and stays off the calendar, and the instant it becomes one it
    // earns its event. Best-effort — Google failing never fails the confirm.
    const googleEventId = await mirrorToGoogleCalendar({
      businessId: params.businessId,
      appointment: updated,
      timezone: business.timezone,
      customer,
    })
    if (googleEventId !== null) {
      updated = await appointmentRepo.update(params.businessId, appointment.id, { googleEventId })
    }

    const niche = await nicheOf(params.businessId)
    notifyOwnerOfPatientConfirmation({
      businessId: params.businessId,
      niche,
      service: updated.service,
      scheduledAt: updated.scheduledAt,
      timezone: business.timezone,
      customer,
    }).catch((err) => {
      logger.warn(
        { err, businessId: params.businessId, appointmentId: updated.id },
        'notifyOwnerOfPatientConfirmation rejected unexpectedly',
      )
    })

    logger.info(
      { businessId: params.businessId, appointmentId: updated.id },
      'patient accepted the slot proposed by the owner',
    )
    return ok({
      appointment: updated,
      scheduledAtDisplay: formatRequestDateTime(updated.scheduledAt, business.timezone),
    })
  } catch (cause) {
    return err(
      new AppError({
        code: 'confirm_pending_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude confirmar la cita en este momento.',
        logContext: { businessId: params.businessId, customerId: params.customerId },
        cause,
      }),
    )
  }
}

export async function cancelAppointment(params: {
  businessId: string
  appointmentId: string
  reason?: string
}): Promise<Result<AppointmentActionResult>> {
  try {
    const ctx = await loadAppointmentContext(params.businessId, params.appointmentId)
    if (!ctx.ok) return ctx
    const { appointment, business, customer } = ctx.data

    // Any status may be cancelled EXCEPT one already cancelled — telling the
    // patient twice that the same appointment is off is worse than a no-op.
    if (appointment.status === 'cancelled') {
      return err(wrongStatus('cancelar', params.businessId, appointment))
    }

    const updated = await appointmentRepo.update(params.businessId, appointment.id, {
      status: 'cancelled',
    })
    await removeGoogleMirror(params.businessId, appointment)

    const reason = params.reason?.trim()
    const text = [
      `${patientGreeting(customer)} Tu cita para ${appointment.service} el ${formatRequestDateTime(appointment.scheduledAt, business.timezone)} ha sido cancelada.`,
      ...(reason ? [reason] : []),
      'Si deseas reagendar, escríbenos.',
    ].join(' ')

    const notified = await messagePatient({
      businessId: params.businessId,
      customerId: customer.id,
      phone: customer.phone,
      text,
    })

    logger.info(
      { businessId: params.businessId, appointmentId: appointment.id, reason },
      'owner cancelled an appointment',
    )
    return ok(actionResult(updated, notified))
  } catch (cause) {
    return err(
      new AppError({
        code: 'cancel_appointment_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude cancelar la cita en este momento.',
        logContext: {
          businessId: params.businessId,
          appointmentId: params.appointmentId,
        },
        cause,
      }),
    )
  }
}
