import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/client.js'
import { appointments, businesses, type Conversation, type Customer } from '@/db/schema/index.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import * as eventsRepo from '@/modules/events/events.repo.js'
import { executeTool } from '@/modules/llm/toolExecutor.js'
import {
  _resetImageExpectationsForTests,
  consumeImageExpectation,
} from '@/modules/whatsapp/imageExpectation.js'
import {
  closeDb,
  DEFAULT_TEST_SETTINGS,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'

// Same trade-off as appointment.test.ts: mock the calendar service rather than
// googleapis, and mock the notifier so a pending request does not try to reach
// a WhatsApp socket that does not exist in tests.
const { mockCreateEvent, mockNotifyOwner } = vi.hoisted(() => ({
  mockCreateEvent: vi.fn(),
  mockNotifyOwner: vi.fn(),
}))

vi.mock('@/modules/google/googleCalendar.service.js', () => ({
  createEvent: mockCreateEvent,
  cancelEvent: vi.fn(),
}))

vi.mock('@/modules/whatsapp/ownerNotifier.js', () => ({
  notifyOwner: mockNotifyOwner,
}))

// Monday, open 09:00–19:00 per DEFAULT_TEST_SETTINGS. Far enough out that the
// minimum-booking-notice filter never drops it. Bump once 2027 rolls around.
const MONDAY_ISO = '2027-07-05'
const SLOT_ISO = `${MONDAY_ISO}T10:00:00-05:00`

describe('toolExecutor deposit gate', () => {
  let seed: TwoBusinessesSeed
  let customerA: Customer
  let conversationA: Conversation

  beforeEach(async () => {
    await resetDb()
    _resetImageExpectationsForTests()
    mockCreateEvent.mockReset()
    mockNotifyOwner.mockReset()
    mockCreateEvent.mockResolvedValue({ ok: false, error: new Error('not connected') })
    mockNotifyOwner.mockResolvedValue(undefined)

    seed = await seedTwoBusinesses()
    await db
      .update(businesses)
      .set({
        settings: {
          ...DEFAULT_TEST_SETTINGS,
          requiresDeposit: true,
          depositAmount: 'S/ 50',
          depositPaymentMethods: [{ method: 'yape' as const, number: '999888777' }],
        },
      })
      .where(eq(businesses.id, seed.businessA.id))

    customerA = await customerRepo.create({
      businessId: seed.businessA.id,
      phone: '+51900004000',
      // The push name WhatsApp handed us — deliberately not the real name.
      name: 'Bebé 💕',
    })
    conversationA = await conversationRepo.create({
      businessId: seed.businessA.id,
      customerId: customerA.id,
    })
  })

  afterAll(async () => {
    await closeDb()
  })

  it('refuses to book with no payment evidence and files nothing', async () => {
    const result = await executeTool(
      'book_appointment',
      { datetime_iso: SLOT_ISO, service: 'corte', customer_name: 'Renzo Romero' },
      {
        businessId: seed.businessA.id,
        conversationId: conversationA.id,
        customerId: customerA.id,
      },
    )

    expect(result.error).toBe('deposit_required')

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, seed.businessA.id))
    expect(rows).toHaveLength(0)
  })

  it('arms the image expectation with the full booking intent, name included', async () => {
    // The whole point of the change: without customerName the image handler
    // would book the appointment under the WhatsApp push name.
    await executeTool(
      'book_appointment',
      { datetime_iso: SLOT_ISO, service: 'corte', customer_name: 'Renzo Romero' },
      {
        businessId: seed.businessA.id,
        conversationId: conversationA.id,
        customerId: customerA.id,
      },
    )

    const expectation = consumeImageExpectation(conversationA.id)

    expect(expectation?.purpose).toBe('payment')
    expect(expectation?.payment).toEqual({
      service: 'corte',
      scheduledAtISO: SLOT_ISO,
      amount: 'S/ 50',
      customerName: 'Renzo Romero',
    })
  })

  it('lets the booking through once a capture was recorded', async () => {
    // `customer_image_received` is the persisted evidence the gate reads back.
    await eventsRepo.create({
      businessId: seed.businessA.id,
      conversationId: conversationA.id,
      type: 'customer_image_received',
      payload: { purpose: 'payment', hasCaption: false },
    })

    const result = await executeTool(
      'book_appointment',
      { datetime_iso: SLOT_ISO, service: 'corte', customer_name: 'Renzo Romero' },
      {
        businessId: seed.businessA.id,
        conversationId: conversationA.id,
        customerId: customerA.id,
      },
    )

    expect(result.error).toBeUndefined()

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, seed.businessA.id))
    expect(rows).toHaveLength(1)
  })

  it('does not accept another business’s capture as evidence', async () => {
    // Multi-tenant isolation on the gate itself: evidence recorded for business
    // B must never unblock a booking for business A.
    const customerB = await customerRepo.create({
      businessId: seed.businessB.id,
      phone: '+51900004001',
      name: 'Cliente B',
    })
    const conversationB = await conversationRepo.create({
      businessId: seed.businessB.id,
      customerId: customerB.id,
    })
    await eventsRepo.create({
      businessId: seed.businessB.id,
      conversationId: conversationB.id,
      type: 'customer_image_received',
      payload: { purpose: 'payment', hasCaption: false },
    })

    const result = await executeTool(
      'book_appointment',
      { datetime_iso: SLOT_ISO, service: 'corte', customer_name: 'Renzo Romero' },
      {
        businessId: seed.businessA.id,
        conversationId: conversationA.id,
        customerId: customerA.id,
      },
    )

    expect(result.error).toBe('deposit_required')

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, seed.businessA.id))
    expect(rows).toHaveLength(0)
  })
})
