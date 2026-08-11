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
