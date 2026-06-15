import { db } from '@/db/client.js'
import {
  appointments,
  businesses,
  conversations,
  events,
  type Conversation,
  type Customer,
} from '@/db/schema/index.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as businessService from '@/modules/business/business.service.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import { ConflictError, NotConfiguredError, ValidationError } from '@/shared/errors.js'
import { eq } from 'drizzle-orm'
import { afterAll, assert, beforeEach, describe, expect, it } from 'vitest'
import {
  closeDb,
  DEFAULT_TEST_SETTINGS,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'

// Calendar references for the fixtures below:
//   2026-06-15 Monday  → open per DEFAULT_TEST_SETTINGS
//   2026-06-21 Sunday  → null per DEFAULT_TEST_SETTINGS (closed)
const MONDAY_ISO = '2026-06-15'
const SUNDAY_ISO = '2026-06-21'

describe('appointment module', () => {
  let seed: TwoBusinessesSeed
  let customerA: Customer
  let conversationA: Conversation

  beforeEach(async () => {
    await resetDb()
    seed = await seedTwoBusinesses()
    customerA = await customerRepo.create({
      businessId: seed.businessA.id,
      phone: '+51900007000',
      name: 'Cliente Test',
    })
    conversationA = await conversationRepo.create({
      businessId: seed.businessA.id,
      customerId: customerA.id,
    })
  })

  afterAll(async () => {
    await closeDb()
  })

  it('checkAvailability returns slots respecting open/close and excluding the break', async () => {
    // Default fixture: 09:00–19:00 with break 13:00–14:00, slot grid 60 min,
    // corte = 30 min. Expected slots: 9, 10, 11, 12, 14, 15, 16, 17, 18 → 9.
    const result = await appointmentService.checkAvailability(
      seed.businessA.id,
      MONDAY_ISO,
      'corte',
    )
    assert(result.ok)
    expect(result.data.availableSlots).toHaveLength(9)
    expect(result.data.availableSlots[0]).toBe(`${MONDAY_ISO}T09:00:00-05:00`)
    // The 13:00 slot would land inside the break, must be excluded.
    expect(result.data.availableSlots).not.toContain(`${MONDAY_ISO}T13:00:00-05:00`)
    expect(result.data.availableSlots).toContain(`${MONDAY_ISO}T14:00:00-05:00`)
    expect(result.data.availableSlots[result.data.availableSlots.length - 1]).toBe(
      `${MONDAY_ISO}T18:00:00-05:00`,
    )
  })

  it('checkAvailability excludes slots already booked', async () => {
    await db.insert(appointments).values([
      {
        businessId: seed.businessA.id,
        customerId: customerA.id,
        service: 'corte',
        scheduledAt: new Date(`${MONDAY_ISO}T10:00:00-05:00`),
      },
      {
        businessId: seed.businessA.id,
        customerId: customerA.id,
        service: 'corte',
        scheduledAt: new Date(`${MONDAY_ISO}T15:00:00-05:00`),
      },
    ])

    const result = await appointmentService.checkAvailability(
      seed.businessA.id,
      MONDAY_ISO,
      'corte',
    )
    assert(result.ok)
    expect(result.data.availableSlots).toHaveLength(7)
    expect(result.data.availableSlots).not.toContain(`${MONDAY_ISO}T10:00:00-05:00`)
    expect(result.data.availableSlots).not.toContain(`${MONDAY_ISO}T15:00:00-05:00`)
  })

  it('checkAvailability returns [] with closedReason when the day is null in settings', async () => {
    const result = await appointmentService.checkAvailability(
      seed.businessA.id,
      SUNDAY_ISO,
      'corte',
    )
    assert(result.ok)
    expect(result.data.availableSlots).toEqual([])
    expect(result.data.closedReason).toBe('cerrado este día')
  })

  it('checkAvailability returns NotConfiguredError when the business has no settings', async () => {
    // Replace settings with empty {} (the schema's "not configured" sentinel).
    await db
      .update(businesses)
      .set({ settings: {} })
      .where(eq(businesses.id, seed.businessA.id))

    const result = await appointmentService.checkAvailability(
      seed.businessA.id,
      MONDAY_ISO,
      'corte',
    )
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(NotConfiguredError)
  })

  it('checkAvailability returns ValidationError when the service is unknown', async () => {
    const result = await appointmentService.checkAvailability(
      seed.businessA.id,
      MONDAY_ISO,
      'masaje cuerpo entero',
    )
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(ValidationError)
    expect(result.error.logContext).toMatchObject({
      availableServices: ['corte', 'barba'],
    })
  })

  it('checkAvailability respects custom operatingHours from settings', async () => {
    // Override Monday to a tight 10:00–12:00 window with no break.
    const updateResult = await businessService.updateSettings(seed.businessA.id, {
      operatingHours: {
        ...DEFAULT_TEST_SETTINGS.operatingHours,
        monday: { open: '10:00', close: '12:00' },
      },
    })
    assert(updateResult.ok)

    const result = await appointmentService.checkAvailability(
      seed.businessA.id,
      MONDAY_ISO,
      'corte',
    )
    assert(result.ok)
    expect(result.data.availableSlots).toEqual([
      `${MONDAY_ISO}T10:00:00-05:00`,
      `${MONDAY_ISO}T11:00:00-05:00`,
    ])
  })

  it('checkAvailability respects business.timezone (Mexico_City returns -06:00 slot offsets)', async () => {
    await db
      .update(businesses)
      .set({ timezone: 'America/Mexico_City' })
      .where(eq(businesses.id, seed.businessA.id))

    const result = await appointmentService.checkAvailability(
      seed.businessA.id,
      MONDAY_ISO,
      'corte',
    )
    assert(result.ok)
    expect(result.data.availableSlots.every((s) => s.endsWith('-06:00'))).toBe(true)
    expect(result.data.availableSlots[0]).toBe(`${MONDAY_ISO}T09:00:00-06:00`)
  })

  it('checkAvailability excludes slots inside a configured break (break logic)', async () => {
    // Reduce slot grid to 30 min so 12:30 and 13:00 and 13:30 are candidate
    // slot starts. With break 13:00–14:00 + 30-min service: 12:30 ends at
    // 13:00 (boundary, allowed), 13:00 starts inside the break, 13:30 starts
    // inside the break. Both 13:00 and 13:30 should be excluded.
    const updateResult = await businessService.updateSettings(seed.businessA.id, {
      slotDurationMinutes: 30,
    })
    assert(updateResult.ok)

    const result = await appointmentService.checkAvailability(
      seed.businessA.id,
      MONDAY_ISO,
      'corte',
    )
    assert(result.ok)
    expect(result.data.availableSlots).toContain(`${MONDAY_ISO}T12:30:00-05:00`)
    expect(result.data.availableSlots).not.toContain(`${MONDAY_ISO}T13:00:00-05:00`)
    expect(result.data.availableSlots).not.toContain(`${MONDAY_ISO}T13:30:00-05:00`)
    expect(result.data.availableSlots).toContain(`${MONDAY_ISO}T14:00:00-05:00`)
  })

  it('bookAppointment creates the appointment with durationMinutes from settings.services', async () => {
    // Default fixture: corte → 30 min.
    const result = await appointmentService.bookAppointment({
      businessId: seed.businessA.id,
      customerId: customerA.id,
      service: 'corte',
      datetimeISO: `${MONDAY_ISO}T11:00:00-05:00`,
    })
    assert(result.ok)
    expect(result.data.durationMinutes).toBe(30)
    expect(result.data.service).toBe('corte')
    expect(result.data.status).toBe('scheduled')

    const rows = await db.select().from(appointments)
    expect(rows).toHaveLength(1)
  })

  it('bookAppointment returns NotConfiguredError when the business has no settings', async () => {
    await db
      .update(businesses)
      .set({ settings: {} })
      .where(eq(businesses.id, seed.businessA.id))

    const result = await appointmentService.bookAppointment({
      businessId: seed.businessA.id,
      customerId: customerA.id,
      service: 'corte',
      datetimeISO: `${MONDAY_ISO}T11:00:00-05:00`,
    })
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(NotConfiguredError)

    const rows = await db.select().from(appointments)
    expect(rows).toHaveLength(0)
  })

  it('bookAppointment returns ValidationError when the service is unknown', async () => {
    const result = await appointmentService.bookAppointment({
      businessId: seed.businessA.id,
      customerId: customerA.id,
      service: 'manicure express',
      datetimeISO: `${MONDAY_ISO}T11:00:00-05:00`,
    })
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(ValidationError)

    const rows = await db.select().from(appointments)
    expect(rows).toHaveLength(0)
  })

  it('bookAppointment rejects a slot that overlaps the break (break logic)', async () => {
    // Default fixture has a 13:00–14:00 break. 12:45 + 30 min service ends at
    // 13:15, which intrudes into the break.
    const result = await appointmentService.bookAppointment({
      businessId: seed.businessA.id,
      customerId: customerA.id,
      service: 'corte',
      datetimeISO: `${MONDAY_ISO}T12:45:00-05:00`,
    })
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(ValidationError)
    expect(result.error.userMessage).toContain('descanso')

    const rows = await db.select().from(appointments)
    expect(rows).toHaveLength(0)
  })

  it('bookAppointment returns ConflictError if the slot is already taken', async () => {
    await appointmentService.bookAppointment({
      businessId: seed.businessA.id,
      customerId: customerA.id,
      service: 'corte',
      datetimeISO: `${MONDAY_ISO}T12:00:00-05:00`,
    })

    const otherCustomer = await customerRepo.create({
      businessId: seed.businessA.id,
      phone: '+51900008000',
      name: 'Otro',
    })
    const result = await appointmentService.bookAppointment({
      businessId: seed.businessA.id,
      customerId: otherCustomer.id,
      service: 'corte',
      datetimeISO: `${MONDAY_ISO}T12:00:00-05:00`,
    })
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(ConflictError)
  })

  it('bookAppointment is idempotent: two identical calls return the same appointment', async () => {
    const params = {
      businessId: seed.businessA.id,
      customerId: customerA.id,
      service: 'corte',
      datetimeISO: `${MONDAY_ISO}T16:00:00-05:00`,
    } as const

    const first = await appointmentService.bookAppointment(params)
    assert(first.ok)
    const second = await appointmentService.bookAppointment(params)
    assert(second.ok)
    expect(second.data.id).toBe(first.data.id)

    const rows = await db.select().from(appointments)
    expect(rows).toHaveLength(1)
  })

  it('escalate marks the conversation as escalated and writes an event', async () => {
    const result = await appointmentService.escalate({
      businessId: seed.businessA.id,
      conversationId: conversationA.id,
      reason: 'cliente molesto',
    })
    assert(result.ok)

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationA.id))
    expect(conv?.status).toBe('escalated')

    const eventRows = await db
      .select()
      .from(events)
      .where(eq(events.conversationId, conversationA.id))
    expect(eventRows).toHaveLength(1)
    expect(eventRows[0]?.type).toBe('escalation')
    expect(eventRows[0]?.payload).toEqual({ reason: 'cliente molesto' })
  })

  it('isolation: appointments of businessA are not seen from businessB', async () => {
    await appointmentService.bookAppointment({
      businessId: seed.businessA.id,
      customerId: customerA.id,
      service: 'corte',
      datetimeISO: `${MONDAY_ISO}T17:00:00-05:00`,
    })

    const fromB = await appointmentService.checkAvailability(
      seed.businessB.id,
      MONDAY_ISO,
      'corte',
    )
    assert(fromB.ok)
    // From B's perspective every default slot is free — A's row never leaks.
    expect(fromB.data.availableSlots).toHaveLength(9)
  })
})
