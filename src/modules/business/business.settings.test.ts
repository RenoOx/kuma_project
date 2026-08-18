import {
  businessSettingsSchema,
  parseBusinessSettings,
  resolveDayHours,
  type BusinessSettings,
} from '@/modules/business/business.settings.js'
import { NotConfiguredError } from '@/shared/errors.js'
import { assert, describe, expect, it } from 'vitest'

const BASE_SETTINGS: BusinessSettings = {
  niche: 'general',
  bookingMode: 'direct',
  appointmentMode: 'appointments_only',
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
    { name: 'corte', durationMinutes: 30, priceMin: 30, priceMax: 30, requiresEvaluation: false },
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
    expect(result.data.specialDays).toEqual([
      { date: '2026-12-25', hours: null, label: 'Navidad' },
    ])
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
