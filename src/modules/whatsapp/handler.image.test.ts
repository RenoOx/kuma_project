import type { WAMessage } from '@whiskeysockets/baileys'
import { eq } from 'drizzle-orm'
import { afterAll, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/client.js'
import {
  appointments,
  businesses,
  type Conversation,
  type Customer,
  customers,
} from '@/db/schema/index.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import {
  closeDb,
  DEFAULT_TEST_SETTINGS,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'
import { handleIncomingMessage } from './handler.js'
import { _resetImageExpectationsForTests, expectImage } from './imageExpectation.js'
import {
  IMAGE_RECEIVED_REPLY,
  PAYMENT_BOOKED_CONFIRMED_REPLY,
  PAYMENT_BOOKED_PENDING_REPLY,
} from './messageKind.js'

// sendWithPresence is mocked to strip the ~3s human delay it stacks on every
// customer-facing message; without this each case here would idle for seconds.
const { mockSendWithPresence, mockCreateEvent, mockNotifyOwner } = vi.hoisted(() => ({
  mockSendWithPresence: vi.fn(),
  mockCreateEvent: vi.fn(),
  mockNotifyOwner: vi.fn(),
}))

vi.mock('@/modules/whatsapp/outbound.js', () => ({
  sendWithPresence: mockSendWithPresence,
}))

vi.mock('@/modules/google/googleCalendar.service.js', () => ({
  createEvent: mockCreateEvent,
  cancelEvent: vi.fn(),
}))

vi.mock('@/modules/whatsapp/ownerNotifier.js', () => ({
  notifyOwner: mockNotifyOwner,
}))

const MONDAY_ISO = '2027-07-05'
const SLOT_ISO = `${MONDAY_ISO}T10:00:00-05:00`
const CUSTOMER_PHONE = '+51900005000'
const CUSTOMER_JID = '51900005000@s.whatsapp.net'

// Minimal Baileys shape classifyIncoming needs to route this as an image.
// `id` matters: the handler drops repeats of a message id it already claimed.
function imageMessage(id: string): WAMessage {
  return {
    key: { remoteJid: CUSTOMER_JID, fromMe: false, id },
    message: { imageMessage: {} },
  } as unknown as WAMessage
}

/** Texts Emma actually sent the customer, in order. */
function repliesSent(): string[] {
  return mockSendWithPresence.mock.calls.map((call) => call[0].text as string)
}

async function setBookingMode(businessId: string, bookingMode: 'direct' | 'requires_approval') {
  await db
    .update(businesses)
    .set({
      settings: {
        ...DEFAULT_TEST_SETTINGS,
        bookingMode,
        requiresDeposit: true,
        depositAmount: 'S/ 50',
        depositPaymentMethods: [{ method: 'yape' as const, number: '999888777' }],
      },
    })
    .where(eq(businesses.id, businessId))
}

describe('handleCustomerImage — booking from a payment capture', () => {
  let seed: TwoBusinessesSeed
  let customerA: Customer
  let conversationA: Conversation
  const send = vi.fn(async () => undefined)

  beforeEach(async () => {
    await resetDb()
    _resetImageExpectationsForTests()
    mockSendWithPresence.mockReset()
    mockSendWithPresence.mockResolvedValue(undefined)
    mockCreateEvent.mockReset()
    mockCreateEvent.mockResolvedValue({ ok: false, error: new Error('not connected') })
    mockNotifyOwner.mockReset()
    mockNotifyOwner.mockResolvedValue(undefined)
    send.mockClear()

    seed = await seedTwoBusinesses()
    customerA = await customerRepo.create({
      businessId: seed.businessA.id,
      phone: CUSTOMER_PHONE,
      // The WhatsApp push name. The booking must overwrite it with the real
      // name Emma collected, which rides along in the payment context.
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

  it('files the appointment the deposit gate held back', async () => {
    // The reported bug: before this, the capture arrived, the owner got the
    // photo, and no appointment ever existed — so "confirma" had nothing to act on.
    await setBookingMode(seed.businessA.id, 'requires_approval')
    expectImage(conversationA.id, 'payment', {
      service: 'corte',
      scheduledAtISO: SLOT_ISO,
      amount: 'S/ 50',
      customerName: 'Renzo Romero',
    })

    await handleIncomingMessage(imageMessage('msg-1'), seed.businessA.id, send)

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, seed.businessA.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.service).toBe('corte')
    // requires_approval keeps a human between the request and the calendar.
    expect(rows[0]?.status).toBe('pending')
    expect(repliesSent()).toContain(PAYMENT_BOOKED_PENDING_REPLY)
  })

  it('books under the name Emma collected, not the WhatsApp push name', async () => {
    await setBookingMode(seed.businessA.id, 'requires_approval')
    expectImage(conversationA.id, 'payment', {
      service: 'corte',
      scheduledAtISO: SLOT_ISO,
      amount: 'S/ 50',
      customerName: 'Renzo Romero',
    })

    await handleIncomingMessage(imageMessage('msg-1'), seed.businessA.id, send)

    const [row] = await db.select().from(customers).where(eq(customers.id, customerA.id))
    expect(row?.name).toBe('Renzo Romero')
  })

  it('confirms outright when the business books directly', async () => {
    await setBookingMode(seed.businessA.id, 'direct')
    expectImage(conversationA.id, 'payment', {
      service: 'corte',
      scheduledAtISO: SLOT_ISO,
      amount: 'S/ 50',
      customerName: 'Renzo Romero',
    })

    await handleIncomingMessage(imageMessage('msg-1'), seed.businessA.id, send)

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, seed.businessA.id))
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('scheduled')
    expect(repliesSent()).toContain(PAYMENT_BOOKED_CONFIRMED_REPLY)
  })

  it('books once when the customer sends two captures back to back', async () => {
    await setBookingMode(seed.businessA.id, 'requires_approval')
    expectImage(conversationA.id, 'payment', {
      service: 'corte',
      scheduledAtISO: SLOT_ISO,
      amount: 'S/ 50',
      customerName: 'Renzo Romero',
    })

    await handleIncomingMessage(imageMessage('msg-1'), seed.businessA.id, send)
    await handleIncomingMessage(imageMessage('msg-2'), seed.businessA.id, send)

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, seed.businessA.id))
    expect(rows).toHaveLength(1)
  })

  it('books nothing for a photo that answers no payment request', async () => {
    // An unsolicited picture, or a reference shot: there is no booking behind
    // it, so nothing should reach the appointments table.
    await setBookingMode(seed.businessA.id, 'requires_approval')

    await handleIncomingMessage(imageMessage('msg-1'), seed.businessA.id, send)

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, seed.businessA.id))
    expect(rows).toHaveLength(0)
    expect(repliesSent()).toContain(IMAGE_RECEIVED_REPLY)
  })

  it('still acknowledges the capture when the booking fails', async () => {
    // Sunday is closed per DEFAULT_TEST_SETTINGS, so bookAppointment rejects.
    // The customer must not be left in silence over it.
    await setBookingMode(seed.businessA.id, 'requires_approval')
    expectImage(conversationA.id, 'payment', {
      service: 'corte',
      scheduledAtISO: '2027-07-04T10:00:00-05:00',
      amount: 'S/ 50',
      customerName: 'Renzo Romero',
    })

    await handleIncomingMessage(imageMessage('msg-1'), seed.businessA.id, send)

    const rows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, seed.businessA.id))
    expect(rows).toHaveLength(0)
    expect(repliesSent()).toHaveLength(1)
    // Never the booked wording — nothing was booked.
    expect(repliesSent()[0]).not.toBe(PAYMENT_BOOKED_PENDING_REPLY)
  })

  it('keeps the booking scoped to the business that received the photo', async () => {
    // Multi-tenant check: business B's tables stay empty even though its
    // conversation is armed with an identical expectation.
    await setBookingMode(seed.businessA.id, 'requires_approval')
    const customerB = await customerRepo.create({
      businessId: seed.businessB.id,
      phone: CUSTOMER_PHONE,
      name: 'Cliente B',
    })
    const conversationB = await conversationRepo.create({
      businessId: seed.businessB.id,
      customerId: customerB.id,
    })
    expectImage(conversationB.id, 'payment', {
      service: 'corte',
      scheduledAtISO: SLOT_ISO,
      amount: 'S/ 50',
      customerName: 'Renzo Romero',
    })
    expectImage(conversationA.id, 'payment', {
      service: 'corte',
      scheduledAtISO: SLOT_ISO,
      amount: 'S/ 50',
      customerName: 'Renzo Romero',
    })

    await handleIncomingMessage(imageMessage('msg-1'), seed.businessA.id, send)

    const rowsA = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, seed.businessA.id))
    const rowsB = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, seed.businessB.id))
    assert(rowsA.length === 1)
    expect(rowsB).toHaveLength(0)
  })
})
