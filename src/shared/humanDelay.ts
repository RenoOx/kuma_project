// ANTI-BAN: simula latencia humana antes de
// responder. Respuestas instantáneas en
// milisegundos son detectadas por Meta como bot.
//
// Shared by handler.ts and callHandler.ts: every outbound message aimed at a
// CUSTOMER goes through it. Internal traffic (notifyOwner, reminders, the owner
// assistant) deliberately does NOT — slowing those down buys nothing.

export const HUMAN_DELAY_MIN_MS = 1500
export const HUMAN_DELAY_MAX_MS = 3000

export function humanDelay(): Promise<void> {
  const ms =
    Math.floor(Math.random() * (HUMAN_DELAY_MAX_MS - HUMAN_DELAY_MIN_MS)) + HUMAN_DELAY_MIN_MS
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// How long "escribiendo…" stays up before the text lands.
//
// This used to be a flat 1.5s regardless of length, which meant a 600-token
// catalogue of eight services with prices was "typed" in the same time as "si".
// Nobody types 1500 characters in a second and a half, and the indicator is
// visible to the customer the whole time — it is one of the few timings the
// person on the other end actually watches.
export const TYPING_MS_PER_CHAR = 35
export const TYPING_MIN_MS = 1_500
export const TYPING_MAX_MS = 5_000
// Two replies of the same length must not hold the indicator for the identical
// number of milliseconds.
const TYPING_JITTER_RATIO = 0.15

/**
 * Plausible typing time for the given text, clamped and jittered.
 *
 * randomFn is injectable for deterministic tests, following the same convention
 * as the reply-variant pickers.
 */
export function typingDelayMs(text: string, randomFn: () => number = Math.random): number {
  const base = text.length * TYPING_MS_PER_CHAR
  const jittered = base * (1 + TYPING_JITTER_RATIO * (randomFn() * 2 - 1))
  return Math.round(Math.min(Math.max(jittered, TYPING_MIN_MS), TYPING_MAX_MS))
}
