// One source for the transcript's internal markers, shared by the two sides
// that care about them: the handler writes them, and the panel turns them back
// into something a human wants to read.
//
// A photo never reaches the LLM (see imageExpectation) and neither does an
// audio note, so the transcript needs a stand-in or the assistant turn that
// follows reads as a non sequitur. Those stand-ins are written FOR the model —
// they carry instructions like "NO llames book_appointment" — which makes
// showing them to the business owner both confusing and unprofessional. This is
// the translation layer.

/**
 * A system-authored marker rather than something a person typed.
 *
 * Every marker the handler writes opens with "[El paciente…" or "[El cliente…"
 * and closes the bracket at the end. Matching that convention rather than each
 * exact string is what makes the fallback below safe: a marker added later is
 * caught even though nothing here knows its wording.
 *
 * Brackets alone would be too broad — a customer who types "[hola]" would have
 * their own message replaced by an attachment label. The two-word opener is
 * what a person is vanishingly unlikely to write by accident.
 *
 * THE CONVENTION IS LORE: a new marker that does not open this way will reach
 * the owner's inbox with its instruction text intact. Keep the prefix.
 */
const MARKER_PATTERN = /^\[El (?:paciente|cliente) .*\]$/s

interface MarkerRendering {
  /** Matched against the marker's text, first hit wins. */
  test: RegExp
  label: string
}

// Ordered: payment captures are also images, so they have to be recognised
// before the plain-image rule.
const MARKER_RENDERINGS: MarkerRendering[] = [
  { test: /captura de pago|comprobante de pago/i, label: '📷 Comprobante de pago recibido' },
  { test: /no puedo procesar/i, label: '📎 Archivo que Emma no puede leer' },
  { test: /envió una imagen|envió la imagen/i, label: '📷 Imagen recibida' },
]

/** What every unrecognised marker collapses to. Never leaks instruction text. */
const GENERIC_MARKER_LABEL = '📎 Adjunto recibido'

const IMAGE_PLACEHOLDER_PREFIX = '[El cliente envió una imagen'

/** The transcript form. Addressed to the model. */
export function buildImagePlaceholder(caption: string | null): string {
  const said = caption?.trim() ? ` con el texto: "${caption.trim()}"` : ''
  return `${IMAGE_PLACEHOLDER_PREFIX}${said}. No puedo verla]`
}

/**
 * The panel form. Addressed to the owner.
 *
 * V1 does not render the media itself — it is never persisted, only forwarded
 * over WhatsApp — so the inbox says what arrived and keeps the caption, which
 * is the part that carries information the owner cannot get anywhere else.
 *
 * Anything that is not a marker passes through untouched, so a customer's own
 * words are never replaced by a label.
 */
export function toPanelDisplay(content: string): string {
  const trimmed = content.trim()
  if (!MARKER_PATTERN.test(trimmed)) return content

  const caption = /con el texto: "([^"]*)"/.exec(trimmed)?.[1]
  const rendering = MARKER_RENDERINGS.find((r) => r.test.test(trimmed))
  const label = rendering?.label ?? GENERIC_MARKER_LABEL

  return caption ? `${label}: "${caption}"` : label
}
