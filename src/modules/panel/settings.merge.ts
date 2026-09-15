import type { Business } from '@/db/schema/index.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'
import { ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import { z } from 'zod'

// Pure half of the settings module: the patch schemas, the merge, and the read
// projection. Split from settings.service.ts so none of it depends on the
// database client — these are the parts worth testing exhaustively, and a test
// that imports them should not open a connection to do it (CLAUDE.md rule 8).

// Every patch schema below is derived from businessSettingsSchema.shape rather
// than redeclared. The HH:mm regexes, the open-before-close refinements and the
// break-inside-hours rules are written once, in business.settings.ts, and the
// panel inherits them — a rule added there applies here without an edit.
const shape = businessSettingsSchema.shape

/**
 * A timezone the host's ICU data actually knows.
 *
 * Checked by construction rather than against a hardcoded list: the list would
 * drift, and a timezone this process cannot format is useless to us whatever a
 * list says. Rejecting it here beats storing it and having every date in the
 * panel throw later.
 */
const timezoneSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('es-PE', { timeZone: tz })
        return true
      } catch {
        return false
      }
    },
    { message: 'unknown IANA timezone' },
  )

// Optional free-text column. Trimmed, and an empty string means "clear it",
// which is why this lands as null rather than '' — the rest of the codebase
// checks these for null, not for emptiness.
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v.length === 0 ? null : v))
    .nullable()
    .optional()

/**
 * Identity and positioning.
 *
 * Straddles two storage locations on purpose: name/ownerName/address/maps and
 * timezone are columns on `businesses`, while niche and appointmentMode live
 * inside the settings jsonb. The owner filling in one form should not have to
 * know which half of it is a column.
 */
export const generalPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    ownerName: optionalText(120),
    address: optionalText(300),
    googleMapsUrl: z.union([z.string().trim().url().max(500), z.literal('')]).optional(),
    timezone: timezoneSchema,
    niche: shape.niche,
    appointmentMode: shape.appointmentMode,
  })
  .partial()

export const schedulePatchSchema = z.object({
  operatingHours: shape.operatingHours,
})

export const specialDaysPatchSchema = z.object({
  // Full replacement, not a merge: the UI owns the whole list and sends it back
  // entire. Merging by date would make "delete this holiday" unexpressible.
  specialDays: shape.specialDays,
})

export const bookingPatchSchema = z
  .object({
    bookingMode: shape.bookingMode,
    slotDurationMinutes: shape.slotDurationMinutes,
    minBookingNoticeMinutes: shape.minBookingNoticeMinutes,
    forwardImages: shape.forwardImages,
    postBooking: shape.postBooking,
  })
  .partial()

/**
 * The service catalogue, replaced whole.
 *
 * Same reasoning as specialDays: these are elements of a jsonb array with no
 * stable ids, so "edit the third one" has nothing to address. The UI owns the
 * list and hands it back entire.
 *
 * The refine is not the same rule as the schema's own `min(1)`. That one keeps
 * a business from having no services at all; this one keeps it from having none
 * that Emma may offer — a catalogue where every row is switched off leaves her
 * with nothing to sell and no way to book.
 */
export const servicesPatchSchema = z
  .object({
    services: shape.services,
  })
  .refine((v) => v.services.some((s) => s.active), {
    message: 'at least one service must be active',
    path: ['services'],
  })

/**
 * Deposit configuration.
 *
 * Writable from the panel, unlike most of the deposit machinery: the owner is
 * the one who knows their Yape number changed. Note what switching
 * requiresDeposit on actually does — the tool executor then refuses EVERY
 * customer-side book_appointment, and shouldForwardImages starts returning true
 * whatever the forwarding toggle says. The UI says so before the switch is
 * flipped; this schema only makes it reachable.
 */
export const paymentsPatchSchema = z
  .object({
    requiresDeposit: shape.requiresDeposit,
    depositAmount: shape.depositAmount,
    depositPaymentMethods: shape.depositPaymentMethods,
  })
  .partial()

/**
 * The global Emma switch.
 *
 * Writes `settings.botPaused`, which already exists and already has its gate in
 * handler.ts: a paused business answers with a canned line, escalates the
 * thread and pushes a notice to the owner. Adding a second global flag beside
 * it would have given the owner two switches for one behaviour, and no way to
 * tell which one was keeping Emma quiet.
 *
 * The panel sends intent — paused or not — and the timestamp is stamped here,
 * so a client cannot backdate a pause.
 */
export const botPatchSchema = z.object({
  paused: z.boolean(),
  reason: z.string().trim().max(200).optional(),
  until: z.string().datetime().optional(),
})

export type BotPatch = z.infer<typeof botPatchSchema>

/** Turns the panel's intent into the stored shape. `paused: false` clears it. */
export function botPausedFromPatch(patch: BotPatch, now: Date = new Date()) {
  if (!patch.paused) return null
  return {
    paused: true as const,
    pausedAt: now.toISOString(),
    ...(patch.until ? { until: patch.until } : {}),
    ...(patch.reason ? { reason: patch.reason } : {}),
  }
}

export type GeneralPatch = z.infer<typeof generalPatchSchema>
export type SchedulePatch = z.infer<typeof schedulePatchSchema>
export type SpecialDaysPatch = z.infer<typeof specialDaysPatchSchema>
export type BookingPatch = z.infer<typeof bookingPatchSchema>
export type ServicesPatch = z.infer<typeof servicesPatchSchema>
export type PaymentsPatch = z.infer<typeof paymentsPatchSchema>

/** The settings half of a general patch. The rest are columns on `businesses`. */
type SettingsPatch = Partial<BusinessSettings>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Applies one section's patch to the stored settings and revalidates the whole
 * object.
 *
 * Pure, and the core of why the panel PATCHes sections instead of PUTting the
 * document the way /admin does. Two properties matter:
 *
 *   1. Keys absent from the patch are carried over untouched. An owner saving
 *      their opening hours cannot drop `services` by omission — which a full
 *      PUT from a form that never loaded services would do.
 *   2. The MERGED object is validated, never the fragment. A patch that is
 *      individually well-formed but leaves the business inconsistent — a break
 *      that now falls outside shortened opening hours, say — is refused here
 *      rather than persisted and discovered by Emma at runtime.
 *
 * `undefined` values in the patch are dropped before merging, so an absent
 * field and an explicitly-undefined one behave the same. Clearing a value is
 * done with null, which is what the schema's nullable fields expect.
 */
export function mergeSettingsSection(
  businessId: string,
  currentRaw: unknown,
  patch: SettingsPatch,
): Result<BusinessSettings> {
  const base = isPlainObject(currentRaw) ? currentRaw : {}

  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  )
  const merged = { ...base, ...defined }

  const parsed = businessSettingsSchema.safeParse(merged)
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) =>
      issue.path.length === 0 ? '<root>' : issue.path.join('.'),
    )
    return err(
      new ValidationError({
        code: 'invalid_settings',
        message: `merged settings failed validation: ${fields.join(', ')}`,
        // Named fields rather than Zod's English messages: this string reaches
        // a shop owner, and "operatingHours.monday" at least points at the row
        // of the form that is wrong.
        userMessage: `La configuración quedó incompleta o inválida: ${fields.join(', ')}.`,
        logContext: { businessId, fields },
      }),
    )
  }

  return ok(parsed.data)
}

/** What the config screen reads on load: the jsonb plus the columns beside it. */
export interface PanelSettingsView {
  name: string
  ownerName: string | null
  address: string | null
  googleMapsUrl: string | null
  timezone: string
  whatsappNumber: string
  /** Null when the business has never been configured — the UI says so rather than inventing defaults. */
  settings: BusinessSettings | null
  /** Field paths that keep the stored settings from validating. Empty when `settings` is non-null. */
  invalidFields: string[]
}

export function readSettings(business: Business): PanelSettingsView {
  const parsed = businessSettingsSchema.safeParse(business.settings)

  return {
    name: business.name,
    ownerName: business.ownerName,
    address: business.address,
    googleMapsUrl: business.googleMapsUrl,
    timezone: business.timezone,
    whatsappNumber: business.whatsappNumber,
    settings: parsed.success ? parsed.data : null,
    invalidFields: parsed.success
      ? []
      : parsed.error.issues.map((issue) =>
          issue.path.length === 0 ? '<root>' : issue.path.join('.'),
        ),
  }
}

