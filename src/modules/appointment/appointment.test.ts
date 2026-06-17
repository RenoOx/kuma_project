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
import { AppError, ConflictError, NotConfiguredError, NotConnectedError, ValidationError } from '@/shared/errors.js'
import { err, ok } from '@/shared/result.js'
import { eq } from 'drizzle-orm'
import { afterAll, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeDb,
  DEFAULT_TEST_SETTINGS,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'

// We mock the calendar service rather than the underlying googleapis client.
// That lets us cover the three integration branches without touching network
// or stubbing the SDK's tree.
const { mockCreateEvent, mockNotifyOwner } = vi.hoisted(() => ({
  mockCreateEvent: vi.fn(),
  mockNotifyOwner: vi.fn(),
}))

vi.mock('@/modules/google/googleCalendar.service.js', () => ({
  createEvent: mockCreateEvent,
  // Keep cancelEvent stubbed — appointment.service doesn't use it today.
  cancelEvent: vi.fn(),
}))

vi.mock('@/modules/whatsapp/ownerNotifier.js', () => ({
  notifyOwner: mockNotifyOwner,
}))

// Calendar references for the fixtures below. Picked in the future relative
// to the current date so the lead-time filter (Día 9.5) doesn't drop slots
// just for being on a past Monday during development.
//   2026-07-06 Monday  → open per DEFAULT_TEST_SETTINGS
//   2026-07-05 Sunday  → null per DEFAULT_TEST_SETTINGS (closed)
const MONDAY_ISO = '2026-07-06'
const SUNDAY_ISO = '2026-07-05'

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
    // Default: every test starts with a business that hasn't connected Google.
    // That matches the pre-Day 8 behavior, so existing tests pass unchanged.
    // Tests that exercise the Google-connected branches override this.
    mockCreateEvent.mockReset()
    mockCreateEvent.mockResolvedValue(
      err(new NotConnectedError({ businessId: seed.businessA.id, service: 'google_calendar' })),
    )
    // Default notifyOwner: resolves to ok. Tests that need a failure override.
    mockNotifyOwner.mockReset()
    mockNotifyOwner.mockResolvedValue(ok(undefined))
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

  it('escalate dispatches notifyOwner with the customer name and the reason', async () => {
    const result = await appointmentService.escalate({
      businessId: seed.businessA.id,
      conversationId: conversationA.id,
      reason: 'cliente pidió humano',
    })
    assert(result.ok)

    // The notify is fire-and-forget and itself does multiple awaited DB
    // lookups, so a single microtask flush isn't enough. waitFor polls.
    await vi.waitFor(
      () => {
        expect(mockNotifyOwner).toHaveBeenCalledTimes(1)
      },
      { timeout: 2000 },
    )

    const [businessIdArg, textArg] = mockNotifyOwner.mock.calls[0] ?? []
    expect(businessIdArg).toBe(seed.businessA.id)
    expect(textArg).toContain('Cliente Test')
    expect(textArg).toContain('cliente pidió humano')
    expect(textArg).toContain('Escalación pendiente')
  })

  it('escalate does NOT fail when notifyOwner rejects', async () => {
    mockNotifyOwner.mockReset()
    mockNotifyOwner.mockResolvedValueOnce(
      err(
        new AppError({
          code: 'notify_owner_failed',
          message: 'simulated send failure',
          userMessage: 'No pude notificar.',
          logContext: { businessId: seed.businessA.id },
        }),
      ),
    )

    const result = await appointmentService.escalate({
      businessId: seed.businessA.id,
      conversationId: conversationA.id,
      reason: 'cliente molesto',
    })
    assert(result.ok)
    await vi.waitFor(
      () => {
        expect(mockNotifyOwner).toHaveBeenCalledTimes(1)
      },
      { timeout: 2000 },
    )

    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationA.id))
    expect(conv?.status).toBe('escalated')
  })

  it('bookAppointment patches the appointment with googleEventId when Google sync succeeds', async () => {
    mockCreateEvent.mockReset()
    mockCreateEvent.mockResolvedValueOnce(
      ok({ googleEventId: 'evt-google-123', htmlLink: 'https://calendar.google.com/event?eid=evt-google-123' }),
    )

    const result = await appointmentService.bookAppointment({
      businessId: seed.businessA.id,
      customerId: customerA.id,
      service: 'corte',
      datetimeISO: `${MONDAY_ISO}T15:00:00-05:00`,
    })
    assert(result.ok)
    expect(result.data.googleEventId).toBe('evt-google-123')

    expect(mockCreateEvent).toHaveBeenCalledTimes(1)
    const createArgs = mockCreateEvent.mock.calls[0]?.[0]
    expect(createArgs).toMatchObject({
      businessId: seed.businessA.id,
      durationMinutes: 30,
      timezone: 'America/Lima',
    })
    // Summary should include the customer's name; description should include phone.
    expect(createArgs.summary).toContain('Cliente Test')
    expect(createArgs.description).toContain('+51900007000')

    const [row] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, result.data.id))
    expect(row?.googleEventId).toBe('evt-google-123')
  })

  it('bookAppointment keeps googleEventId null when the business has no Google connected', async () => {
    // Default mock (set in beforeEach) returns NotConnectedError.
    const result = await appointmentService.bookAppointment({
      businessId: seed.businessA.id,
      customerId: customerA.id,
      service: 'corte',
      datetimeISO: `${MONDAY_ISO}T16:00:00-05:00`,
    })
    assert(result.ok)
    expect(result.data.googleEventId).toBeNull()

    const [row] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, result.data.id))
    expect(row?.googleEventId).toBeNull()
  })

  it('bookAppointment still persists the local appointment when Google returns a random error', async () => {
    mockCreateEvent.mockReset()
    mockCreateEvent.mockResolvedValueOnce(
      err(
        new AppError({
          code: 'google_create_event_failed',
          message: 'simulated google 500',
          userMessage: 'No pude crear el evento en Google Calendar.',
          logContext: { businessId: seed.businessA.id },
        }),
      ),
    )

    const result = await appointmentService.bookAppointment({
      businessId: seed.businessA.id,
      customerId: customerA.id,
      service: 'corte',
      datetimeISO: `${MONDAY_ISO}T17:00:00-05:00`,
    })
    assert(result.ok)
    expect(result.data.googleEventId).toBeNull()

    const rows = await db.select().from(appointments)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(result.data.id)
  })

  it('checkAvailability excludes slots whose start time already passed or are under the lead-time threshold', async () => {
    // Spy on Date.now() instead of vi.useFakeTimers — the latter freezes
    // setTimeout/setInterval, which postgres-js needs for its internal
    // bookkeeping and would hang every DB query in this test.
    const fakeNow = new Date(`${MONDAY_ISO}T13:30:00-05:00`).getTime()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fakeNow)
    try {
      const result = await appointmentService.checkAvailability(
        seed.businessA.id,
        MONDAY_ISO,
        'corte',
      )
      assert(result.ok)
      // Default lead time 30 min → earliest acceptable 14:00. With the
      // configured break 13:00–14:00, slots 14:00–18:00 remain (five).
      expect(result.data.availableSlots).toEqual([
        `${MONDAY_ISO}T14:00:00-05:00`,
        `${MONDAY_ISO}T15:00:00-05:00`,
        `${MONDAY_ISO}T16:00:00-05:00`,
        `${MONDAY_ISO}T17:00:00-05:00`,
        `${MONDAY_ISO}T18:00:00-05:00`,
      ])
    } finally {
      spy.mockRestore()
    }
  })

  it('bookAppointment returns ValidationError slot_too_soon when the slot is under minBookingNoticeMinutes', async () => {
    // Now = 11:00 Lima. Requested slot is 11:15 — 15 min away, under the
    // 30-min default lead time. Day is open and slot is not in the break.
    const fakeNow = new Date(`${MONDAY_ISO}T11:00:00-05:00`).getTime()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fakeNow)
    try {
      const result = await appointmentService.bookAppointment({
        businessId: seed.businessA.id,
        customerId: customerA.id,
        service: 'corte',
        datetimeISO: `${MONDAY_ISO}T11:15:00-05:00`,
      })
      assert(!result.ok)
      expect(result.error).toBeInstanceOf(ValidationError)
      expect(result.error.code).toBe('slot_too_soon')
      expect(result.error.logContext).toMatchObject({ minNoticeMinutes: 30 })

      const rows = await db.select().from(appointments)
      expect(rows).toHaveLength(0)
    } finally {
      spy.mockRestore()
    }
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
