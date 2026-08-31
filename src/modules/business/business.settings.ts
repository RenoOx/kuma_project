import { z } from 'zod'
import { NotConfiguredError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'

const timeHHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'expected HH:mm 24-hour time')

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

// A service is priced in one of three ways, and Emma answers differently for
// each (see formatServicePrice):
//   - fixed      → priceMin === priceMax
//   - range      → priceMin < priceMax, or priceMax null for open-ended
//   - evaluation → requiresEvaluation, real price known only after seeing the
//                  case; priceMin may still act as a floor ("desde S/ X")
//
// durationMinutes is null when the service has no fixed length. Slot math and
// calendar events then fall back to slotDurationMinutes — see
// resolveServiceDurationMinutes, which is the only supported way to read it.
//
// referenceUrl points at whatever the business already uses to show the work
// (Canva deck, Drive folder, portfolio). It only makes sense for
// evaluation-first services, where the customer needs to see examples before
// any price can be quoted, so the admin form only offers it there. We validate
// the URL shape and nothing else — the destination is the owner's business.
const serviceSchema = z
  .object({
    name: z.string().min(1),
    durationMinutes: z
      .number()
      .int()
      .positive()
      .nullish()
      .transform((v) => v ?? null),
    priceMin: z
      .number()
      .nonnegative()
      .nullish()
      .transform((v) => v ?? null),
    priceMax: z
      .number()
      .nonnegative()
      .nullish()
      .transform((v) => v ?? null),
    requiresEvaluation: z.boolean().default(false),
    referenceUrl: z.string().url().optional(),
  })
  .refine((s) => s.requiresEvaluation || s.priceMin !== null, {
    message: 'priceMin is required unless the service requires evaluation',
    path: ['priceMin'],
  })
  .refine((s) => s.priceMin === null || s.priceMax === null || s.priceMax >= s.priceMin, {
    message: 'priceMax must be greater than or equal to priceMin',
    path: ['priceMax'],
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

// How the business receives customers, which decides whether Emma treats a
// booking as the only way in or as one of two options:
//   - appointments_only → by appointment only. Emma's original behaviour.
//   - hybrid            → walk-ins by arrival order AND optional appointments.
// Defaults to appointments_only so businesses configured before this field
// existed keep their exact behaviour without a data migration.
const appointmentModeSchema = z.enum(['appointments_only', 'hybrid']).default('appointments_only')

// Which conversation flow the business runs, and therefore which state machine
// and which per-state tools apply:
//   - appointments → book a slot (clinics, barbershops, aesthetics)
//   - sales        → inform, charge, collect data (courses, certifications)
// Defaults to appointments so businesses configured before this field existed
// keep their exact behaviour without a data migration.
// NOTE: does not replace appointmentMode yet — both coexist. appointmentMode is
// still the field prompts.ts reads for the call-to-action decision.
const flowTypeSchema = z.enum(['appointments', 'sales']).default('appointments')

// Fields Emma must collect from the customer before closing, in the sales flow.
// Free-form on purpose: each business names its own ("nombre", "DNI", "correo").
// Empty by default — the appointments flow collects nothing extra.
const collectDataFieldsSchema = z.array(z.string().min(1)).default([])

// Optional post-booking modules, switched per business. All off by default:
// every one of these sends a proactive message to the customer, which is the
// owner's call to make, not a default they discover after it already went out
// (same reasoning as forwardImages).
//
// recallAfterDays: null = never recall; a positive integer = days after the
// appointment to reactivate the customer.
//
// .prefault({}) rather than .default({}): in Zod 4 `.default()` takes the OUTPUT
// type, so it would demand the full literal here and duplicate every inner
// default. `.prefault()` takes the INPUT type, so `{}` gets parsed and the inner
// defaults fill it in — they stay the single source of truth.
const postBookingSchema = z
  .object({
    reminders: z.boolean().default(false),
    confirmationReply: z.boolean().default(false),
    postCareFollowUp: z.boolean().default(false),
    recallAfterDays: z.number().int().positive().nullable().default(null),
    followUpAbandoned: z.boolean().default(false),
  })
  .prefault({})

// Business category. Will condition prompt behaviour, KB keyword detection and
// niche-specific rules (not yet wired — this is the structural field only).
// Defaults to 'general' so businesses configured before this field existed
// keep working without a data migration.
const nicheSchema = z
  .enum(['dental', 'barberia', 'estetica', 'salud', 'general'])
  .default('general')

export const NICHE_LABELS: Record<z.infer<typeof nicheSchema>, string> = {
  dental: 'Clínica Dental',
  barberia: 'Barbería',
  estetica: 'Centro Estético / Spa',
  salud: 'Salud y Bienestar',
  general: 'Otro',
}

// Whether Emma closes a booking on her own or only files a request:
//   - direct            → books straight away, status 'scheduled'. Current
//                         behaviour, right for barbershops and salons.
//   - requires_approval → books as 'pending' and pushes the request to the
//                         owner, who confirms outside Emma. Right for clinics.
// Defaults to direct so businesses configured before this field existed keep
// their exact behaviour without a data migration.
const bookingModeSchema = z.enum(['direct', 'requires_approval']).default('direct')

export const BOOKING_MODE_LABELS: Record<z.infer<typeof bookingModeSchema>, string> = {
  direct: 'Agenda directa',
  requires_approval: 'Requiere aprobación',
}

// Whether a customer's photo is relayed to the owner's WhatsApp instead of only
// announced in text. Off by default: forwarding a customer's picture to a third
// number is the owner's call to make, not a default they discover after it
// already happened.
const forwardImagesSchema = z.boolean().default(false)

// Deposit ("adelanto") a customer pays to hold their slot. When required, Emma
// refuses to file the booking until the customer has sent a photo — enforced in
// the tool executor, not in the prompt, because the prompt alone did not hold.
//
// `depositAmount` is free text on purpose: "S/ 20", "el 50%" and "S/ 20 por
// persona" are all things owners actually say, and parsing them into a number
// would only force a shape the business does not have.
export const DEPOSIT_METHODS = ['yape', 'plin', 'transferencia', 'efectivo'] as const

export const DEPOSIT_METHOD_LABELS: Record<(typeof DEPOSIT_METHODS)[number], string> = {
  yape: 'Yape',
  plin: 'Plin',
  transferencia: 'Transferencia',
  efectivo: 'Efectivo',
}

const depositPaymentMethodSchema = z.object({
  method: z.enum(DEPOSIT_METHODS),
  number: z.string().optional(),
  label: z.string().optional(),
})

export const businessSettingsSchema = z.object({
  niche: nicheSchema,
  bookingMode: bookingModeSchema,
  forwardImages: forwardImagesSchema,
  requiresDeposit: z.boolean().default(false),
  depositAmount: z.string().optional(),
  depositPaymentMethods: z.array(depositPaymentMethodSchema).default([]),
  operatingHours: operatingHoursSchema,
  slotDurationMinutes: z.number().int().positive(),
  services: z.array(serviceSchema).min(1, 'at least one service is required'),
  appointmentMode: appointmentModeSchema,
  flowType: flowTypeSchema,
  collectDataFields: collectDataFieldsSchema,
  postBooking: postBookingSchema,
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
export type AppointmentMode = z.infer<typeof appointmentModeSchema>
export type FlowType = z.infer<typeof flowTypeSchema>
export type PostBookingSettings = z.infer<typeof postBookingSchema>
export type Niche = z.infer<typeof nicheSchema>
export type BookingMode = z.infer<typeof bookingModeSchema>
export type ForwardImages = z.infer<typeof forwardImagesSchema>
export type DepositPaymentMethod = z.infer<typeof depositPaymentMethodSchema>
export type DayKey = keyof BusinessSettings['operatingHours']

// A business that charges a deposit has to SEE the capture, otherwise it is
// taking the customer's word for it — the exact hole the deposit gate exists to
// close. So requiring a deposit implies forwarding, whatever the toggle says.
// Read forwarding through here; never `settings.forwardImages` directly.
export function shouldForwardImages(settings: BusinessSettings): boolean {
  return settings.forwardImages || settings.requiresDeposit
}

// Renders the payment methods as one line, for the prompt and for the refusal
// the model reads when the deposit gate blocks a booking.
export function formatPaymentMethods(methods: DepositPaymentMethod[]): string {
  if (methods.length === 0) return 'no hay formas de pago configuradas'
  return methods
    .map((m) => {
      const name = DEPOSIT_METHOD_LABELS[m.method]
      const number = m.number?.trim()
      const label = m.label?.trim()
      const detail = [number, label ? `(${label})` : null].filter(Boolean).join(' ')
      return detail ? `${name}: ${detail}` : name
    })
    .join(' · ')
}

// Default lead time when the business hasn't set its own value.
export const DEFAULT_MIN_BOOKING_NOTICE_MINUTES = 30

// Pure read: minutes of lead time required by the business for a booking
// to be acceptable. Used by checkAvailability and bookAppointment.
export function getMinBookingNoticeMinutes(settings: BusinessSettings): number {
  return settings.minBookingNoticeMinutes ?? DEFAULT_MIN_BOOKING_NOTICE_MINUTES
}

// Effective length of a service. `durationMinutes: null` means the business
// never set one (typically an evaluation-first service), so we fall back to the
// slot grid: appointments.duration_minutes is NOT NULL and a calendar event
// needs an end time, so a number has to come out of here either way.
// Read service duration through this — never `service.durationMinutes` directly.
export function resolveServiceDurationMinutes(
  service: Service,
  settings: BusinessSettings,
): number {
  return service.durationMinutes ?? settings.slotDurationMinutes
}

// Pure render of a service's price, in the three shapes Emma has to answer.
// Shared by the system prompt and the admin panel so both read the same way.
export function formatServicePrice(service: Service): string {
  const { priceMin, priceMax, requiresEvaluation } = service

  if (requiresEvaluation) {
    return priceMin === null
      ? 'requiere evaluación previa'
      : `desde S/ ${priceMin} (requiere evaluación previa)`
  }
  // Unreachable through the schema (the refine above demands a priceMin when
  // requiresEvaluation is false), kept so this stays total.
  if (priceMin === null) return 'precio no configurado'
  if (priceMax === null) return `desde S/ ${priceMin}`
  if (priceMin === priceMax) return `S/ ${priceMin}`
  return `S/ ${priceMin} a S/ ${priceMax}`
}

// Pure check: given a settings object (or null when business is unconfigured),
// is the customer-facing bot currently paused? Used by handler.ts and the
// owner tool executor.
export function isBotPausedNow(settings: BusinessSettings | null, now: Date = new Date()): boolean {
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
export function resolveDayHours(
  settings: BusinessSettings,
  dateISO: string,
  dayKey: DayKey,
): DayHours {
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
export function parseBusinessSettings(businessId: string, raw: unknown): Result<BusinessSettings> {
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
