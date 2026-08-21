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
