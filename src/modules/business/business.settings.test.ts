import { assert, describe, expect, it } from 'vitest'
import {
  activeServices,
  type BusinessSettings,
  businessSettingsSchema,
  parseBusinessSettings,
  remindersExplicitlyDisabled,
  resolveDayHours,
} from '@/modules/business/business.settings.js'
import { NotConfiguredError } from '@/shared/errors.js'

const BASE_SETTINGS: BusinessSettings = {
  niche: 'general',
  bookingMode: 'direct',
  forwardImages: false,
  requiresDeposit: false,
  depositPaymentMethods: [],
  appointmentMode: 'appointments_only',
  flowType: 'appointments',
  collectDataFields: [],
  postBooking: {
    reminders: false,
    confirmationReply: false,
    postCareFollowUp: false,
    recallAfterDays: null,
    followUpAbandoned: false,
  },
  operatingHours: {
    monday: { open: '09:00', close: '19:00' },
    tuesday: { open: '09:00', close: '19:00' },
    wednesday: { open: '09:00', close: '19:00' },
    thursday: { open: '09:00', close: '19:00' },
    friday: { open: '09:00', close: '19:00' },
    saturday: { open: '09:00', close: '13:00' },
    sunday: null,
  },
  slotDurationMinutes: 60,
  services: [
    {
      name: 'corte',
      durationMinutes: 30,
      priceMin: 30,
      priceMax: 30,
      requiresEvaluation: false,
      active: true,
    },
  ],
}

describe('business.settings — service price', () => {
  it('accepts a service with a fixed price', () => {
    const result = parseBusinessSettings('biz1', BASE_SETTINGS)
    assert(result.ok)
    expect(result.data.services[0]?.priceMin).toBe(30)
    expect(result.data.services[0]?.priceMax).toBe(30)
  })

  it('accepts a price range', () => {
    const result = parseBusinessSettings('biz1', {
      ...BASE_SETTINGS,
      services: [{ name: 'tinte', durationMinutes: 45, priceMin: 60, priceMax: 90 }],
    })
    assert(result.ok)
    expect(result.data.services[0]?.priceMin).toBe(60)
    expect(result.data.services[0]?.priceMax).toBe(90)
    expect(result.data.services[0]?.requiresEvaluation).toBe(false)
  })

  it('accepts an evaluation-first service with no prices', () => {
    const result = parseBusinessSettings('biz1', {
      ...BASE_SETTINGS,
      services: [{ name: 'ondulación', durationMinutes: null, requiresEvaluation: true }],
    })
    assert(result.ok)
    expect(result.data.services[0]?.priceMin).toBeNull()
    expect(result.data.services[0]?.durationMinutes).toBeNull()
  })

  it('rejects a negative price', () => {
    const parsed = businessSettingsSchema.safeParse({
      ...BASE_SETTINGS,
      services: [{ name: 'corte', durationMinutes: 30, priceMin: -5 }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects a priced service without priceMin', () => {
    const parsed = businessSettingsSchema.safeParse({
      ...BASE_SETTINGS,
      services: [{ name: 'corte', durationMinutes: 30, priceMax: 40 }],
    })
    expect(parsed.success).toBe(false)
  })

  it('rejects priceMax below priceMin', () => {
    const parsed = businessSettingsSchema.safeParse({
      ...BASE_SETTINGS,
      services: [{ name: 'corte', durationMinutes: 30, priceMin: 90, priceMax: 60 }],
    })
    expect(parsed.success).toBe(false)
  })
})

describe('business.settings — specialDays', () => {
  it('parses a closed special day (hours: null)', () => {
    const result = parseBusinessSettings('biz1', {
      ...BASE_SETTINGS,
      specialDays: [{ date: '2026-12-25', hours: null, label: 'Navidad' }],
    })
    assert(result.ok)
    expect(result.data.specialDays).toEqual([{ date: '2026-12-25', hours: null, label: 'Navidad' }])
  })

  it('parses a special day with custom hours', () => {
    const result = parseBusinessSettings('biz1', {
      ...BASE_SETTINGS,
      specialDays: [{ date: '2026-12-24', hours: { open: '09:00', close: '13:00' } }],
    })
    assert(result.ok)
    expect(result.data.specialDays?.[0]?.hours).toEqual({ open: '09:00', close: '13:00' })
  })

  it('rejects a malformed date', () => {
    const parsed = businessSettingsSchema.safeParse({
      ...BASE_SETTINGS,
      specialDays: [{ date: '25-12-2026', hours: null }],
    })
    expect(parsed.success).toBe(false)
  })

  it('is optional — settings without specialDays still parse', () => {
    const result = parseBusinessSettings('biz1', BASE_SETTINGS)
    assert(result.ok)
    expect(result.data.specialDays).toBeUndefined()
  })
})

describe('resolveDayHours', () => {
  it('falls back to the weekly operatingHours when there is no override for that date', () => {
    const hours = resolveDayHours(BASE_SETTINGS, '2026-06-15', 'monday')
    expect(hours).toEqual({ open: '09:00', close: '19:00' })
  })

  it('returns null (closed) when a specialDays entry overrides that date', () => {
    const settings: BusinessSettings = {
      ...BASE_SETTINGS,
      specialDays: [{ date: '2026-06-15', hours: null, label: 'Feriado' }],
    }
    const hours = resolveDayHours(settings, '2026-06-15', 'monday')
    expect(hours).toBeNull()
  })

  it('returns the specialDays custom hours instead of the weekly schedule', () => {
    const settings: BusinessSettings = {
      ...BASE_SETTINGS,
      specialDays: [{ date: '2026-06-15', hours: { open: '10:00', close: '12:00' } }],
    }
    const hours = resolveDayHours(settings, '2026-06-15', 'monday')
    expect(hours).toEqual({ open: '10:00', close: '12:00' })
  })

  it('does not affect other dates for the same weekday', () => {
    const settings: BusinessSettings = {
      ...BASE_SETTINGS,
      specialDays: [{ date: '2026-06-15', hours: null }],
    }
    // 2026-06-22 is also a Monday, but has no override.
    const hours = resolveDayHours(settings, '2026-06-22', 'monday')
    expect(hours).toEqual({ open: '09:00', close: '19:00' })
  })
})

describe('parseBusinessSettings — not configured sentinel (regression)', () => {
  it('still returns NotConfiguredError for an empty object', () => {
    const result = parseBusinessSettings('biz1', {})
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(NotConfiguredError)
  })
})

describe('business.settings — remindersExplicitlyDisabled', () => {
  // The gate is explicit-opt-out on purpose: a business configured before
  // postBooking existed parses as reminders:false, and treating that as a
  // choice would silence reminders that go out today.
  it('does not disable reminders for settings with no postBooking block', () => {
    // BASE_SETTINGS carries a full postBooking block with reminders off, which
    // is the opposite case — what this one is about is a row saved before the
    // field existed, so the key has to be genuinely absent.
    const { postBooking: _omitted, ...withoutPostBooking } = BASE_SETTINGS
    expect(remindersExplicitlyDisabled(withoutPostBooking)).toBe(false)
  })

  it('does not disable reminders when postBooking omits the key', () => {
    expect(remindersExplicitlyDisabled({ ...BASE_SETTINGS, postBooking: {} })).toBe(false)
  })

  it('disables reminders only on a stored false', () => {
    const off = {
      ...BASE_SETTINGS,
      postBooking: { ...BASE_SETTINGS.postBooking, reminders: false },
    }
    expect(remindersExplicitlyDisabled(off)).toBe(true)
  })

  it('keeps reminders on when the owner switched them on', () => {
    const on = { ...BASE_SETTINGS, postBooking: { ...BASE_SETTINGS.postBooking, reminders: true } }
    expect(remindersExplicitlyDisabled(on)).toBe(false)
  })

  it('treats junk as "never answered" rather than as off', () => {
    for (const raw of [null, undefined, 'nonsense', 42, [], {}]) {
      expect(remindersExplicitlyDisabled(raw)).toBe(false)
    }
    expect(remindersExplicitlyDisabled({ postBooking: 'nonsense' })).toBe(false)
    // A stringified flag is not a boolean false; only a real false counts.
    expect(remindersExplicitlyDisabled({ postBooking: { reminders: 'false' } })).toBe(false)
  })
})

describe('business.settings — active services', () => {
  const withServices = (services: unknown[]) => ({ ...BASE_SETTINGS, services })

  it('parses a service with no active field as active', () => {
    // Services stored before the field existed keep working without a data
    // migration — that is what the default is for.
    const result = parseBusinessSettings('biz1', {
      ...BASE_SETTINGS,
      services: [{ name: 'corte', durationMinutes: 30, priceMin: 30, priceMax: 30 }],
    })
    assert(result.ok)
    expect(result.data.services[0]?.active).toBe(true)
  })

  it('honours an explicit false', () => {
    const result = parseBusinessSettings(
      'biz1',
      withServices([
        { name: 'corte', durationMinutes: 30, priceMin: 30, priceMax: 30, active: false },
      ]),
    )
    assert(result.ok)
    expect(result.data.services[0]?.active).toBe(false)
  })

  it('activeServices returns only the ones Emma may offer', () => {
    const result = parseBusinessSettings(
      'biz1',
      withServices([
        { name: 'corte', durationMinutes: 30, priceMin: 30, priceMax: 30, active: true },
        { name: 'barba', durationMinutes: 20, priceMin: 20, priceMax: 20, active: false },
        { name: 'cejas', durationMinutes: 15, priceMin: 15, priceMax: 15 },
      ]),
    )
    assert(result.ok)
    expect(activeServices(result.data).map((s) => s.name)).toEqual(['corte', 'cejas'])
  })

  it('returns an empty list when everything is switched off', () => {
    // Callers render "sin servicios" rather than assuming a first element. The
    // panel refuses to SAVE this state, but settings written by other paths can
    // still reach it.
    const result = parseBusinessSettings(
      'biz1',
      withServices([
        { name: 'corte', durationMinutes: 30, priceMin: 30, priceMax: 30, active: false },
      ]),
    )
    assert(result.ok)
    expect(activeServices(result.data)).toEqual([])
  })

  it('deactivating keeps the price and duration', () => {
    // The whole reason it is a flag and not a delete: a seasonal service comes
    // back without being retyped.
    const result = parseBusinessSettings(
      'biz1',
      withServices([
        { name: 'botox', durationMinutes: 45, priceMin: 300, priceMax: 500, active: false },
      ]),
    )
    assert(result.ok)
    const [service] = result.data.services
    expect(service?.priceMin).toBe(300)
    expect(service?.priceMax).toBe(500)
    expect(service?.durationMinutes).toBe(45)
  })
})
