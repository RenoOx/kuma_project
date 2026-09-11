import { randomBytes, timingSafeEqual } from 'node:crypto'

// The panel's whole auth story is a link the owner keeps in their phone. That
// makes this token a bearer credential with no expiry, so it gets treated like
// one: 32 bytes of CSPRNG output, compared in constant time, never logged.
//
// base64url rather than hex so 32 bytes fit in 43 characters — comfortably
// inside the varchar(64) column, and short enough that the link stays
// forwardable over WhatsApp without wrapping.
const TOKEN_BYTES = 32

export function generatePanelToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/**
 * Constant-time token comparison.
 *
 * `===` on a secret leaks its prefix through timing, and while a remote timing
 * attack over Railway's TLS is not the likeliest way to lose this token, the
 * fix costs nothing. Length is checked first because timingSafeEqual throws on
 * mismatched buffers — that check is itself a length oracle, which is harmless:
 * every token we mint is the same length.
 */
export function panelTokenMatches(stored: string | null, provided: string | null): boolean {
  if (!stored || !provided) return false
  const a = Buffer.from(stored, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
