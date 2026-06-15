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

const serviceSchema = z.object({
  name: z.string().min(1),
  durationMinutes: z.number().int().positive(),
})

export const businessSettingsSchema = z.object({
  operatingHours: operatingHoursSchema,
  slotDurationMinutes: z.number().int().positive(),
  services: z.array(serviceSchema).min(1, 'at least one service is required'),
})

export type BusinessSettings = z.infer<typeof businessSettingsSchema>
export type DayHours = z.infer<typeof dayHoursSchema>
export type DayBreak = z.infer<typeof breakSchema>
export type Service = z.infer<typeof serviceSchema>
export type DayKey = keyof BusinessSettings['operatingHours']

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
