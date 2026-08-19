// Names reach us from two places that both produce a mess: the WhatsApp push
// name (whatever the customer set on their own profile) and free text typed
// into a chat ("juan perez", "JUAN PEREZ"). This renders them the way a person
// would write them, at DISPLAY time — so rows already stored come out right
// without a backfill.

// Kept lowercase unless they open the name: "juan de la cruz" reads as
// "Juan de la Cruz", not "Juan De La Cruz". Common enough in Peru that the
// naive title-case is visibly wrong.
const PARTICLES = new Set([
  'de',
  'del',
  'la',
  'las',
  'los',
  'y',
  'e',
  'da',
  'das',
  'do',
  'dos',
  'van',
  'von',
])

function capitalize(word: string): string {
  const first = word[0]
  if (first === undefined) return word
  return first.toUpperCase() + word.slice(1)
}

/**
 * Title-cases a person's name, but ONLY when the input carries no case
 * information of its own.
 *
 * A name written all-lowercase or ALL-UPPERCASE is the customer typing fast or
 * with caps lock on — there is nothing to preserve. Anything with mixed case
 * ("McCarthy", "de la Cruz", "Ana Sofía") was written deliberately, and
 * rewriting it would only make it worse.
 *
 * Returns null for empty / whitespace-only input so callers can pick their own
 * fallback instead of rendering an empty string.
 */
export function formatPersonName(raw: string | null | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().replace(/\s+/g, ' ')
  if (trimmed.length === 0) return null

  const hasMixedCase = trimmed !== trimmed.toLowerCase() && trimmed !== trimmed.toUpperCase()
  if (hasMixedCase) return trimmed

  return trimmed
    .toLowerCase()
    .split(' ')
    .map((word, index) => (index > 0 && PARTICLES.has(word) ? word : capitalize(word)))
    .join(' ')
}
