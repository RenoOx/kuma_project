import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetImageExpectationsForTests,
  consumeImageExpectation,
  expectImage,
  IMAGE_EXPECTATION_TTL_MS,
  type PaymentContext,
} from './imageExpectation.js'

// Fake timers are safe here for the same reason they are in messageBuffer.test:
// this module holds no DB handle, so freezing the clock cannot stall postgres-js.

const CONVERSATION_ID = 'conv-payment-1'

const PAYMENT: PaymentContext = {
  service: 'brackets',
  scheduledAtISO: '2027-07-05T15:00:00.000Z',
  amount: 'S/ 50',
  customerName: 'Renzo Romero',
}

describe('imageExpectation', () => {
  beforeEach(() => {
    _resetImageExpectationsForTests()
  })

  afterEach(() => {
    vi.useRealTimers()
    _resetImageExpectationsForTests()
  })

  it('carries the whole booking intent, customer name included', () => {
    // The name is the field the image handler cannot recover on its own: the
    // deposit gate blocked book_appointment, so the rename it performs never
    // ran and the customer row may still hold the WhatsApp push name.
    expectImage(CONVERSATION_ID, 'payment', PAYMENT)

    const found = consumeImageExpectation(CONVERSATION_ID)

    expect(found?.purpose).toBe('payment')
    expect(found?.payment).toEqual({
      service: 'brackets',
      scheduledAtISO: '2027-07-05T15:00:00.000Z',
      amount: 'S/ 50',
      customerName: 'Renzo Romero',
    })
  })

  it('hands the expectation to exactly one reader', () => {
    // This is what stops two captures sent back to back from booking twice:
    // the second read finds nothing, so the handler never reaches bookAppointment.
    expectImage(CONVERSATION_ID, 'payment', PAYMENT)

    expect(consumeImageExpectation(CONVERSATION_ID)).not.toBeNull()
    expect(consumeImageExpectation(CONVERSATION_ID)).toBeNull()
  })

  it('keeps expectations separate per conversation', () => {
    // Multi-tenant safety at the in-memory layer: one customer's payment intent
    // must never be consumed by a photo from another conversation.
    expectImage('conv-a', 'payment', PAYMENT)

    expect(consumeImageExpectation('conv-b')).toBeNull()
    expect(consumeImageExpectation('conv-a')?.payment?.service).toBe('brackets')
  })

  it('drops an expectation older than the TTL', () => {
    vi.useFakeTimers()
    expectImage(CONVERSATION_ID, 'payment', PAYMENT)

    vi.advanceTimersByTime(IMAGE_EXPECTATION_TTL_MS + 1)

    expect(consumeImageExpectation(CONVERSATION_ID)).toBeNull()
  })

  it('still returns an expectation read just inside the TTL', () => {
    vi.useFakeTimers()
    expectImage(CONVERSATION_ID, 'payment', PAYMENT)

    vi.advanceTimersByTime(IMAGE_EXPECTATION_TTL_MS - 1000)

    expect(consumeImageExpectation(CONVERSATION_ID)?.payment?.customerName).toBe('Renzo Romero')
  })

  it('leaves payment null for a plain request_image call', () => {
    // A reference shot has no booking behind it, so nothing should be booked
    // when it arrives.
    expectImage(CONVERSATION_ID, 'reference')

    const found = consumeImageExpectation(CONVERSATION_ID)

    expect(found?.purpose).toBe('reference')
    expect(found?.payment).toBeNull()
  })

  it('returns null when nothing was ever expected', () => {
    expect(consumeImageExpectation('never-armed')).toBeNull()
  })
})
