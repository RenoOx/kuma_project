// Emma cannot see what a customer sent, so "is this photo worth the owner's
// attention?" cannot be answered from the image. It is answered from whether
// Emma ASKED for one: she requests a payment capture or a reference shot, and
// the photo that follows is the answer to that request.
//
// Everything else stays unforwarded. A customer's unsolicited picture is not
// something to relay to a third phone by default.
//
// In memory on purpose, same trade-off as the unsupported-notice cooldown and
// the message buffer: a deploy clears it and the next photo simply falls back
// to the old behaviour. The money-critical path does not depend on this alone —
// a customer with a pending appointment is forwarded regardless, and that
// signal lives in the database.

export type ImagePurpose = 'payment' | 'reference'

/**
 * The booking the customer is paying for, carried from the deposit gate.
 *
 * Needed because under that gate the appointment does NOT exist yet — it is
 * blocked precisely until this photo lands — so `findPendingByCustomer` finds
 * nothing and the owner would otherwise get a payment capture with no idea
 * which appointment it belongs to.
 */
export interface PaymentContext {
  service: string
  /** ISO instant the customer asked for, as the model sent it. */
  scheduledAtISO: string
  /** Free-text deposit, e.g. "S/ 20". Null when the business set no amount. */
  amount: string | null
  /**
   * The name the customer gave Emma, carried because the booking this unblocks
   * is filed from the image handler, not from the model. The gate blocked
   * book_appointment, so the rename it performs never ran and the customer row
   * may still hold the WhatsApp push name.
   */
  customerName: string
}

export interface ImageExpectation {
  purpose: ImagePurpose
  /** Set only by the deposit gate; null for plain request_image calls. */
  payment: PaymentContext | null
}

interface Expectation extends ImageExpectation {
  expiresAt: number
}

// Long enough to survive the customer switching apps to take a screenshot of
// their bank, short enough that a photo sent the next day isn't relayed because
// of something Emma asked yesterday.
export const IMAGE_EXPECTATION_TTL_MS = 30 * 60 * 1000

const expectations = new Map<string, Expectation>()

export function expectImage(
  conversationId: string,
  purpose: ImagePurpose,
  payment: PaymentContext | null = null,
): void {
  expectations.set(conversationId, {
    purpose,
    payment,
    expiresAt: Date.now() + IMAGE_EXPECTATION_TTL_MS,
  })
}

/**
 * Arms the gate for a photo the model just asked for, WITHOUT discarding the
 * booking a live payment expectation is already carrying.
 *
 * The two halves are armed from different places: the deposit gate stores the
 * booking when it refuses, and `request_image` fires afterwards to ask for the
 * photo. Routing that second call through plain `expectImage` overwrote the
 * booking with null, so the capture landed with nothing to book and the
 * appointment was never created — the gate destroyed its own intent by
 * following its own instruction.
 *
 * Only a `payment` request inherits the context. A reference shot must NOT, or
 * the photo answering it would file an appointment nobody paid for.
 */
export function expectImageKeepingPayment(conversationId: string, purpose: ImagePurpose): void {
  expectImage(
    conversationId,
    purpose,
    purpose === 'payment' ? readLivePayment(conversationId) : null,
  )
}

// Non-consuming read that still honours the TTL, so a stale context cannot be
// resurrected by a request_image arriving long after it lapsed.
function readLivePayment(conversationId: string): PaymentContext | null {
  const found = expectations.get(conversationId)
  if (!found || found.expiresAt <= Date.now()) return null
  return found.payment
}

/**
 * Reads the pending request and clears it — one request buys one forward.
 *
 * Without the clear, a single "send me the capture" would relay every photo for
 * the next half hour.
 */
export function consumeImageExpectation(conversationId: string): ImageExpectation | null {
  const found = expectations.get(conversationId)
  if (!found) return null
  expectations.delete(conversationId)
  if (found.expiresAt <= Date.now()) return null
  return { purpose: found.purpose, payment: found.payment }
}

export function _resetImageExpectationsForTests(): void {
  expectations.clear()
}
