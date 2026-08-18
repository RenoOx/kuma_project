/**
 * Phone numbers reach this system in two shapes, and the difference is easy to
 * miss by eye:
 *
 *   - `extractPhone` (whatsapp/handler) always builds "+51987654321" from an
 *     inbound JID — the leading "+" is not optional there.
 *   - The admin panel's own placeholder tells operators to type "51987654321",
 *     without it, so that is what most rows in the database look like.
 *
 * A strict `===` between those two is false, which silently routed business
 * owners into the CUSTOMER flow: Emma answered her own boss as if he were a
 * patient ("no tengo acceso a las citas, contacta al consultorio"). The bug hid
 * for a while because every OUTBOUND path strips the "+" before building a JID,
 * so the owner kept receiving notifications and only failed to be recognised
 * when he wrote back.
 *
 * Anything that compares or stores a phone goes through here.
 */

/** Digits only, prefixed with "+". Null for input carrying no digits at all. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  return digits.length === 0 ? null : `+${digits}`
}

/**
 * True when both values denote the same number, whatever shape each arrived in.
 *
 * Null/empty never matches — "no owner configured" must not compare equal to
 * "no phone extracted", or an unparsable JID would be greeted as the owner.
 */
export function samePhone(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const normalizedA = normalizePhone(a)
  return normalizedA !== null && normalizedA === normalizePhone(b)
}
