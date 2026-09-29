import type { Message } from '@/db/schema/index.js'

const MS_PER_HOUR = 60 * 60 * 1000

/**
 * Cuántas horas pasaron desde la última actividad ANTERIOR a este turno.
 *
 * `history` viene en orden cronológico y ya trae al final lo que el cliente
 * acaba de escribir — a veces varios mensajes seguidos. Esos son el turno, no
 * la actividad previa: se saltean todos los del cliente del final y se mide
 * contra el mensaje de antes. Sin nada antes (conversación nueva): null, no hay
 * de qué reiniciar.
 */
export function hoursSinceLastActivity(history: Message[], now: Date): number | null {
  let i = history.length - 1
  while (i >= 0 && history[i]?.role === 'user') i--
  const previous = history[i]
  if (!previous) return null
  return (now.getTime() - previous.createdAt.getTime()) / MS_PER_HOUR
}
