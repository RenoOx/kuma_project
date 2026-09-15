import { describe, expect, it } from 'vitest'
import type { Business } from '@/db/schema/index.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import {
  bookingPatchSchema,
  generalPatchSchema,
  mergeSettingsSection,
  paymentsPatchSchema,
  readSettings,
  schedulePatchSchema,
  servicesPatchSchema,
  specialDaysPatchSchema,
} from '@/modules/panel/settings.merge.js'

const BASE_SETTINGS: BusinessSettings = {
  niche: 'barberia',
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

describe('mergeSettingsSection — carrying the document forward', () => {
  // The reason the panel PATCHes sections instead of PUTting the document:
  // the schedule form never loads `services`, and must not be able to drop it.
  it('keeps fields the patch does not mention', () => {
    const result = mergeSettingsSection('biz1', BASE_SETTINGS, {
      operatingHours: {
        ...BASE_SETTINGS.operatingHours,
        sunday: { open: '10:00', close: '14:00' },
      },
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.services).toHaveLength(1)
    expect(result.data.services[0]?.name).toBe('corte')
    expect(result.data.slotDurationMinutes).toBe(60)
    expect(result.data.niche).toBe('barberia')
    expect(result.data.operatingHours.sunday).toEqual({ open: '10:00', close: '14:00' })
  })

  it('ignores undefined values instead of erasing the stored one', () => {
    const result = mergeSettingsSection('biz1', BASE_SETTINGS, {
      bookingMode: undefined,
      niche: 'dental',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.bookingMode).toBe('direct')
    expect(result.data.niche).toBe('dental')
  })

  it('does not mutate the stored settings it was handed', () => {
    const stored = structuredClone(BASE_SETTINGS)
    mergeSettingsSection('biz1', stored, { niche: 'estetica' })
    expect(stored.niche).toBe('barberia')
  })
})

describe('mergeSettingsSection — validating the merged whole', () => {
  // A patch can be well-formed on its own and still leave the business
  // inconsistent. Validating the fragment would let this through; validating
  // the merge is what catches it.
  it('rejects a break that no longer fits inside shortened hours', () => {
    const withBreak = mergeSettingsSection('biz1', BASE_SETTINGS, {
      operatingHours: {
        ...BASE_SETTINGS.operatingHours,
        monday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
      },
    })
    expect(withBreak.ok).toBe(true)
    if (!withBreak.ok) return

    const shortened = mergeSettingsSection('biz1', withBreak.data, {
      operatingHours: {
        ...withBreak.data.operatingHours,
        monday: { open: '09:00', close: '12:00', break: { start: '13:00', end: '14:00' } },
      },
    })

    expect(shortened.ok).toBe(false)
    if (shortened.ok) return
    expect(shortened.error.code).toBe('invalid_settings')
  })

  it('names the failing fields in the message the owner sees', () => {
    const result = mergeSettingsSection('biz1', BASE_SETTINGS, {
      slotDurationMinutes: -5,
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.userMessage).toContain('slotDurationMinutes')
    expect(result.error.logContext.businessId).toBe('biz1')
  })

  it('refuses to save a section over settings that were never configured', () => {
    // No defaults, per CLAUDE.md: a business with no settings cannot acquire a
    // valid document by saving one section of it.
    const result = mergeSettingsSection('biz1', {}, { niche: 'dental' })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.userMessage).toContain('services')
  })

  it('treats a non-object stored value as empty rather than throwing', () => {
    for (const stored of [null, undefined, 'nonsense', 42, []]) {
      const result = mergeSettingsSection('biz1', stored, { niche: 'dental' })
      expect(result.ok).toBe(false)
    }
  })

  it('accepts a complete document written over an empty one', () => {
    const result = mergeSettingsSection('biz1', {}, BASE_SETTINGS)
    expect(result.ok).toBe(true)
  })
})

describe('patch schemas — what the panel is allowed to send', () => {
  // Rule 3 in CLAUDE.md. The tenant comes from the authenticated path, never
  // from a body: no patch schema has a businessId field, so a caller that sends
  // one has it stripped by the parse rather than honoured.
  it('strips a businessId smuggled into any section body', () => {
    const injected = { businessId: 'other-tenant', id: 'other-tenant' }

    const general = generalPatchSchema.parse({ ...injected, name: 'Barbería' })
    expect(general).not.toHaveProperty('businessId')
    expect(general).not.toHaveProperty('id')

    const booking = bookingPatchSchema.parse({ ...injected, bookingMode: 'direct' })
    expect(booking).not.toHaveProperty('businessId')

    const schedule = schedulePatchSchema.parse({
      ...injected,
      operatingHours: BASE_SETTINGS.operatingHours,
    })
    expect(schedule).not.toHaveProperty('businessId')

    const special = specialDaysPatchSchema.parse({ ...injected, specialDays: [] })
    expect(special).not.toHaveProperty('businessId')
  })

  it('keeps each section to its own fields', () => {
    // Services and the deposit ARE editable from the panel, but each through its
    // own section. A booking patch carrying them is parsed into nothing, so a
    // form that posts more than it owns cannot reach past its section.
    const parsed = bookingPatchSchema.parse({
      requiresDeposit: true,
      services: [],
      bookingMode: 'requires_approval',
    })

    expect(parsed).toEqual({ bookingMode: 'requires_approval' })
  })

  it('keeps flowType and botPaused out of the section schemas', () => {
    // flowType picks the state machine and is not the owner's to change at all.
    // botPaused IS theirs, but only through botPatchSchema, which stamps the
    // timestamp itself — reaching it through a section patch would let a client
    // write a pause state of its own shape.
    const smuggled = { flowType: 'sales', botPaused: { paused: true } }

    expect(bookingPatchSchema.parse({ ...smuggled })).toEqual({})
    expect(paymentsPatchSchema.parse({ ...smuggled })).toEqual({})
    expect(generalPatchSchema.parse({ ...smuggled })).toEqual({})
  })

  it('rejects a timezone the host cannot format dates in', () => {
    expect(generalPatchSchema.safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false)
    expect(generalPatchSchema.safeParse({ timezone: 'America/Lima' }).success).toBe(true)
  })

  it('normalises a cleared text field to null rather than an empty string', () => {
    const parsed = generalPatchSchema.parse({ ownerName: '  ', address: '' })
    expect(parsed.ownerName).toBeNull()
    expect(parsed.address).toBeNull()
  })

  it('refuses an empty business name', () => {
    expect(generalPatchSchema.safeParse({ name: '   ' }).success).toBe(false)
  })
})

describe('readSettings', () => {
  const business = (settings: unknown): Business =>
    ({
      id: 'biz1',
      name: 'Imperio Barber',
      whatsappNumber: '+51999888777',
      timezone: 'America/Lima',
      systemPrompt: null,
      settings,
      ownerWhatsappNumber: null,
      ownerName: 'Renzo',
      address: null,
      googleMapsUrl: null,
      panelToken: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as Business

  it('returns the parsed settings alongside the columns', () => {
    const view = readSettings(business(BASE_SETTINGS))
    expect(view.settings?.niche).toBe('barberia')
    expect(view.name).toBe('Imperio Barber')
    expect(view.ownerName).toBe('Renzo')
    expect(view.invalidFields).toEqual([])
  })

  it('reports null settings and the missing fields for an unconfigured business', () => {
    const view = readSettings(business({}))
    expect(view.settings).toBeNull()
    expect(view.invalidFields.length).toBeGreaterThan(0)
    // The columns still render: the owner can rename the business even while
    // the rest of the configuration is incomplete.
    expect(view.name).toBe('Imperio Barber')
  })

  it('never echoes the panel token back to the client', () => {
    const view = readSettings(business(BASE_SETTINGS))
    expect(view).not.toHaveProperty('panelToken')
  })
})

describe('servicesPatchSchema', () => {
  const service = (name: string, active: boolean) => ({
    name,
    durationMinutes: 30,
    priceMin: 30,
    priceMax: 30,
    requiresEvaluation: false,
    active,
  })

  it('accepts a catalogue with at least one active service', () => {
    const parsed = servicesPatchSchema.safeParse({
      services: [service('corte', true), service('barba', false)],
    })
    expect(parsed.success).toBe(true)
  })

  it('refuses a catalogue where every service is switched off', () => {
    // The schema's own min(1) does not catch this: there ARE services, just
    // none Emma may offer, which leaves her nothing to sell and no way to book.
    const parsed = servicesPatchSchema.safeParse({
      services: [service('corte', false), service('barba', false)],
    })
    expect(parsed.success).toBe(false)
  })

  it('refuses an empty catalogue', () => {
    expect(servicesPatchSchema.safeParse({ services: [] }).success).toBe(false)
  })

  it('treats a service with no active field as active', () => {
    // Services stored before the field existed must keep working untouched.
    const parsed = servicesPatchSchema.safeParse({
      services: [{ name: 'corte', durationMinutes: 30, priceMin: 30, priceMax: 30 }],
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.services[0]?.active).toBe(true)
  })
})

describe('paymentsPatchSchema', () => {
  it('accepts a partial patch', () => {
    const parsed = paymentsPatchSchema.parse({ requiresDeposit: true })
    expect(parsed).toEqual({ requiresDeposit: true })
  })

  it('keeps depositAmount as free text', () => {
    // "el 50%" and "S/ 20 por persona" are both things owners actually say;
    // parsing them into a number would force a shape the business lacks.
    for (const amount of ['S/ 20', 'el 50%', 'S/ 20 por persona']) {
      expect(paymentsPatchSchema.safeParse({ depositAmount: amount }).success).toBe(true)
    }
  })

  it('refuses a payment method outside the closed set', () => {
    expect(
      paymentsPatchSchema.safeParse({ depositPaymentMethods: [{ method: 'bitcoin' }] }).success,
    ).toBe(false)
    expect(
      paymentsPatchSchema.safeParse({ depositPaymentMethods: [{ method: 'yape' }] }).success,
    ).toBe(true)
  })

  it('merges into stored settings without touching the catalogue', () => {
    const result = mergeSettingsSection('biz1', BASE_SETTINGS, {
      requiresDeposit: true,
      depositAmount: 'S/ 20',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.data.requiresDeposit).toBe(true)
    expect(result.data.services).toHaveLength(1)
    expect(result.data.services[0]?.name).toBe('corte')
  })
})
