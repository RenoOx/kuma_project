import { NotConfiguredError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import { z } from 'zod'

const timeHHMM = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm 24-hour time')

const breakSchema = z.object({
  start: timeHHMM,
  end: timeHHMM,
})

const dayHoursSchema = z
  .object({
    open: timeHHMM,
    close: timeHHMM,
    break: breakSchema.optional(),
  })
  .refine((v) => v.open < v.close, {
    message: 'open must be earlier than close',
  })
  .refine((v) => !v.break || v.break.start < v.break.end, {
    message: 'break.start must be earlier than break.end',
  })
  .refine((v) => !v.break || v.break.start > v.open, {
    message: 'break.start must be later than open',
  })
  .refine((v) => !v.break || v.break.end < v.close, {
    message: 'break.end must be earlier than close',
  })
  .nullable()

const operatingHoursSchema = z.object({
  monday: dayHoursSchema,
  tuesday: dayHoursSchema,
  wednesday: dayHoursSchema,
  thursday: dayHoursSchema,
  friday: dayHoursSchema,
  saturday: dayHoursSchema,
  sunday: dayHoursSchema,
})

// Date-specific override of operatingHours (holiday closure, one-off special
// hours). `hours: null` means closed that day; an object means custom hours
// for that day only — same shape as a weekly dayHoursSchema entry.
const specialDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  hours: dayHoursSchema,
  label: z.string().optional(),
})

const serviceSchema = z.object({
  name: z.string().min(1),
  durationMinutes: z.number().int().positive(),
  // Optional — services without a set price fall back to the free-text
  // knowledge_base "pricing" entries when Emma answers.
  price: z.number().nonnegative().optional(),
})

// Pause state for the customer-facing bot. The owner toggles this via the
// ownerAssistant `pause_bot` / `resume_bot` tools.
//   - paused=true + no until    → indefinite pause
//   - paused=true + until set   → auto-resume once `until` is in the past
//   - paused=false / null / absent → bot is live
const botPausedSchema = z.object({
  paused: z.boolean(),
  pausedAt: z.string().datetime(),
  until: z.string().datetime().optional(),
  reason: z.string().optional(),
})

export const businessSettingsSchema = z.object({
  operatingHours: operatingHoursSchema,
  slotDurationMinutes: z.number().int().positive(),
  services: z.array(serviceSchema).min(1, 'at least one service is required'),
  // Optional + nullable so the owner can both leave it unset and explicitly
  // clear it back to null via `resume_bot`.
  botPaused: botPausedSchema.nullable().optional(),
  // Minimum lead time (in minutes) between "now" and a bookable slot.
  // Excludes past slots and slots too close in the immediate future.
  // Optional — falls back to DEFAULT_MIN_BOOKING_NOTICE_MINUTES (30) when unset.
  minBookingNoticeMinutes: z.number().int().min(0).max(1440).optional(),
  // Date-specific exceptions to operatingHours (holidays, one-off special
  // hours). Optional — businesses without any keep using the weekly schedule.
  specialDays: z.array(specialDaySchema).optional(),
})

export type BusinessSettings = z.infer<typeof businessSettingsSchema>
export type DayHours = z.infer<typeof dayHoursSchema>
export type DayBreak = z.infer<typeof breakSchema>
export type Service = z.infer<typeof serviceSchema>
export type BotPausedState = z.infer<typeof botPausedSchema>
export type SpecialDay = z.infer<typeof specialDaySchema>
export type DayKey = keyof BusinessSettings['operatingHours']

// Default lead time when the business hasn't set its own value.
export const DEFAULT_MIN_BOOKING_NOTICE_MINUTES = 30

// Pure read: minutes of lead time required by the business for a booking
// to be acceptable. Used by checkAvailability and bookAppointment.
export function getMinBookingNoticeMinutes(settings: BusinessSettings): number {
  return settings.minBookingNoticeMinutes ?? DEFAULT_MIN_BOOKING_NOTICE_MINUTES
}

// Pure check: given a settings object (or null when business is unconfigured),
// is the customer-facing bot currently paused? Used by handler.ts and the
// owner tool executor.
export function isBotPausedNow(
  settings: BusinessSettings | null,
  now: Date = new Date(),
): boolean {
  const state = settings?.botPaused
  if (!state || !state.paused) return false
  if (state.until && Date.parse(state.until) <= now.getTime()) return false
  return true
}

// JS Date.getDay() index → day key. Keep in sync with operatingHoursSchema.
const dayKeysByJsDow: readonly DayKey[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
]

export function dayKeyForJsDow(dow: number): DayKey | null {
  return dayKeysByJsDow[dow] ?? null
}

// Resolves the effective hours for a specific calendar date: a matching
// specialDays entry overrides the recurring weekly operatingHours for that
// date. Used by checkAvailability and bookAppointment so both stay in sync —
// call this instead of reading settings.operatingHours[dayKey] directly.
export function resolveDayHours(settings: BusinessSettings, dateISO: string, dayKey: DayKey): DayHours {
  const special = settings.specialDays?.find((d) => d.date === dateISO)
  if (special) return special.hours
  return settings.operatingHours[dayKey]
}

function isEmptyObject(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  )
}

// Returns ok(settings) when raw matches the schema. Returns NotConfiguredError
// for the common "not configured" shapes (null, undefined, {}) as well as for
// partial / invalid payloads, with `missing` filled from Zod's path issues.
export function parseBusinessSettings(
  businessId: string,
  raw: unknown,
): Result<BusinessSettings> {
  if (raw === null || raw === undefined || isEmptyObject(raw)) {
    return err(
      new NotConfiguredError({
        businessId,
        missing: ['operatingHours', 'slotDurationMinutes', 'services'],
      }),
    )
  }

  const parsed = businessSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    const missing = parsed.error.issues.map((issue) =>
      issue.path.length === 0 ? '<root>' : issue.path.join('.'),
    )
    return err(
      new NotConfiguredError({
        businessId,
        missing,
        cause: parsed.error,
      }),
    )
  }

  return ok(parsed.data)
}
