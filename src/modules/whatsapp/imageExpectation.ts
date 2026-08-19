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

interface Expectation {
  purpose: ImagePurpose
  expiresAt: number
}

// Long enough to survive the customer switching apps to take a screenshot of
// their bank, short enough that a photo sent the next day isn't relayed because
// of something Emma asked yesterday.
export const IMAGE_EXPECTATION_TTL_MS = 30 * 60 * 1000

const expectations = new Map<string, Expectation>()

export function expectImage(conversationId: string, purpose: ImagePurpose): void {
  expectations.set(conversationId, {
    purpose,
    expiresAt: Date.now() + IMAGE_EXPECTATION_TTL_MS,
  })
}

/**
 * Reads the pending request and clears it — one request buys one forward.
 *
 * Without the clear, a single "send me the capture" would relay every photo for
 * the next half hour.
 */
export function consumeImageExpectation(conversationId: string): ImagePurpose | null {
  const found = expectations.get(conversationId)
  if (!found) return null
  expectations.delete(conversationId)
  return found.expiresAt > Date.now() ? found.purpose : null
}

export function _resetImageExpectationsForTests(): void {
  expectations.clear()
}
