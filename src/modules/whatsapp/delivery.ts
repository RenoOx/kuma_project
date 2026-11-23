import type { WAMessage } from '@whiskeysockets/baileys'

// Cuándo y cómo llegó un mensaje. Sin Baileys vivo, sin base: lo que decide el
// handler con el sobre que ya tiene en la mano.

/**
 * Hasta cuánto tarde se contesta un mensaje que WhatsApp entregó al reconectar.
 *
 * Un deploy o un corte de minutos deja mensajes de hace minutos: se contestan
 * como si hubieran llegado recién. Uno de hace más de medio día no: Emma le
 * respondería "¿cuál es tu objetivo?" a alguien que escribió ayer, y lo que
 * corresponde es que lo vea el dueño. Se guarda en el Inbox y se le avisa.
 */
export const OFFLINE_REPLY_MAX_AGE_MS = 12 * 60 * 60 * 1000

/** `messageTimestamp` viene en segundos, como número o como `Long` de protobuf. */
function timestampSeconds(value: WAMessage['messageTimestamp']): number | null {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object' && 'toNumber' in value) {
    const n = value.toNumber()
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** Cuánto hace que el cliente lo mandó, o null si el sobre no trae la hora. */
export function messageAgeMs(raw: Pick<WAMessage, 'messageTimestamp'>, now: number): number | null {
  const seconds = timestampSeconds(raw.messageTimestamp)
  if (seconds === null || seconds <= 0) return null
  return Math.max(0, now - seconds * 1000)
}

/**
 * Si es demasiado viejo para que Emma lo conteste. Sin hora, no: ante la duda
 * se contesta, que un mensaje sin respuesta es justo el bug que esto arregla.
 */
export function isTooOldToAnswer(raw: Pick<WAMessage, 'messageTimestamp'>, now: number): boolean {
  const age = messageAgeMs(raw, now)
  return age !== null && age > OFFLINE_REPLY_MAX_AGE_MS
}
