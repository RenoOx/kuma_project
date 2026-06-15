import { logger } from '@/config/logger.js'
import type { Appointment } from '@/db/schema/index.js'
import * as businessService from '@/modules/business/business.service.js'
import {
  dayKeyForJsDow,
  type BusinessSettings,
  type DayBreak,
  type DayHours,
  type Service,
} from '@/modules/business/business.settings.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as eventsRepo from '@/modules/events/events.repo.js'
import { AppError, ConflictError, ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as appointmentRepo from './appointment.repo.js'

const IDEMPOTENCY_WINDOW_MS = 30_000

export interface CheckAvailabilityResult {
  availableSlots: string[]
  closedReason?: string
}

function normalizeServiceName(s: string): string {
  return s.toLowerCase().trim()
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
    const tzName = formatter
      .formatToParts(sample)
      .find((p) => p.type === 'timeZoneName')?.value
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

    const dayHours = settings.operatingHours[dayKey]
    if (dayHours === null) {
      return ok({ availableSlots: [], closedReason: 'cerrado este día' })
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

    const candidates = buildSlots({
      dateISO,
      hours: dayHours,
      slotDurationMinutes: settings.slotDurationMinutes,
      serviceDurationMinutes: knownService.durationMinutes,
      tzOffset,
    })

    const dayStart = new Date(`${dateISO}T00:00:00${tzOffset}`)
    const dayEnd = new Date(`${dateISO}T23:59:59${tzOffset}`)
    const taken = await appointmentRepo.findByBusinessAndDateRange(businessId, dayStart, dayEnd)
    // V1: exact-instant comparison. Long services that span multiple slot
    // grid units can leave gaps marked "available" when the slot before is
    // actually occupied. See "deuda técnica" notes in the Día 7 report.
    const takenInstants = new Set(taken.map((a) => a.scheduledAt.getTime()))

    const availableSlots = candidates.filter((iso) => !takenInstants.has(new Date(iso).getTime()))
    return ok({ availableSlots })
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
}

export async function bookAppointment(
  params: BookAppointmentParams,
): Promise<Result<Appointment>> {
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
          logContext: { businessId: params.businessId, timezone: business.timezone },
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
    const dayHours = settings.operatingHours[dayKey]
    if (dayHours === null) {
      return err(
        new ValidationError({
          message: 'business closed on this day',
          userMessage: 'El negocio no atiende ese día.',
          logContext: { businessId: params.businessId, datetimeISO: params.datetimeISO, dayKey },
        }),
      )
    }
    if (dayHours.break && overlapsBreak(tzWallTimeMin, knownService.durationMinutes, dayHours.break)) {
      return err(
        new ValidationError({
          message: 'requested slot overlaps the configured break',
          userMessage: 'Ese horario coincide con el descanso del negocio. Por favor elegí otro slot.',
          logContext: {
            businessId: params.businessId,
            datetimeISO: params.datetimeISO,
            break: dayHours.break,
            serviceDurationMinutes: knownService.durationMinutes,
          },
        }),
      )
    }

    // Idempotency: same (customer, slot, service) booked in last 30s wins.
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

    const existing = await appointmentRepo.findByDateTime(params.businessId, datetime)
    if (existing) {
      return err(
        new ConflictError({
          message: 'slot already booked',
          userMessage: 'Ese horario ya está reservado, elegí otro.',
          logContext: {
            businessId: params.businessId,
            datetimeISO: params.datetimeISO,
            existingAppointmentId: existing.id,
          },
        }),
      )
    }

    const created = await appointmentRepo.create({
      businessId: params.businessId,
      customerId: params.customerId,
      service: params.service,
      scheduledAt: datetime,
      durationMinutes: knownService.durationMinutes,
      status: 'scheduled',
    })
    return ok(created)
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

export interface EscalateParams {
  businessId: string
  conversationId: string
  reason: string
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
    return ok(undefined)
  } catch (cause) {
    return err(
      new AppError({
        code: 'escalate_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude derivar a un humano en este momento.',
        logContext: { businessId: params.businessId, conversationId: params.conversationId },
        cause,
      }),
    )
  }
}
