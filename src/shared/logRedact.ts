import { env } from '@/config/env.js'

// Message content is patient content. A clinic's log stream should not be a
// readable transcript of what people wrote about their health, their money or
// their appointments — and Railway keeps those lines around long after the
// conversation is over.
//
// Previews stay outside production, where they are genuinely the fastest way to
// see what the bot understood. In production the field simply disappears: Pino
// omits `undefined` values, so no call site needs a conditional and no log line
// grows an empty key.

/**
 * A short excerpt of a message, for logs — or nothing at all in production.
 *
 * Pair it with a length field where the size matters: `replyLen` answers "was
 * the answer truncated?" without quoting the patient.
 */
export function preview(text: string, max = 60): string | undefined {
  if (env.NODE_ENV === 'production') return undefined
  return text.slice(0, max)
}
