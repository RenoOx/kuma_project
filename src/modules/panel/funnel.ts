// El embudo de ventas del panel (Dashboard), para negocios de venta.
//
// Cuenta conversaciones, no mensajes: de los leads que entraron en el período,
// cuántos llegaron a cada etapa. Las etapas del medio las declara el archivo
// del negocio (`funnel`: qué mensajes fijos cuentan como "recibió la oferta",
// "recibió el pago"…); las de las puntas son del motor: los leads adelante, y
// atrás la foto pedida y Pagó / No pagó (las etiquetas de calificación).
//
// Puro a propósito: el repo trae las filas, esto las cuenta, y se testea sin base.

import type { FunnelStage } from '@/config/businesses/define.js'

export interface FunnelStep {
  label: string
  count: number
  /** Sobre los leads del período, redondeado. 0 si no hubo leads. */
  pct: number
}

export type QualificationOutcome = 'pending' | 'paid' | 'not_paid'

export interface FunnelInput {
  stages: readonly FunnelStage[]
  /** Las conversaciones de clientes creadas en el período: la cohorte. */
  conversationIds: readonly string[]
  /** Por conversación, los ids de mensajes fijos que se le mandaron. */
  fixedSent: ReadonlyMap<string, ReadonlySet<string>>
  /** Las que mandaron la foto que Emma pidió (Emma se pausó por foto). */
  sentPhoto: ReadonlySet<string>
  /** La etiqueta de calificación actual de cada conversación que tiene una. */
  qualification: ReadonlyMap<string, QualificationOutcome>
}

function step(label: string, count: number, leads: number): FunnelStep {
  return { label, count, pct: leads === 0 ? 0 : Math.round((count / leads) * 100) }
}

export function buildFunnel(input: FunnelInput): FunnelStep[] {
  const leads = input.conversationIds.length
  const steps: FunnelStep[] = [step('Leads', leads, leads)]

  for (const stage of input.stages) {
    const ids = new Set(stage.fixedMessages)
    const reached = input.conversationIds.filter((id) => {
      const sent = input.fixedSent.get(id)
      if (!sent) return false
      for (const messageId of sent) if (ids.has(messageId)) return true
      return false
    }).length
    steps.push(step(stage.label, reached, leads))
  }

  const photo = input.conversationIds.filter((id) => input.sentPhoto.has(id)).length
  const paid = input.conversationIds.filter((id) => input.qualification.get(id) === 'paid').length
  const notPaid = input.conversationIds.filter(
    (id) => input.qualification.get(id) === 'not_paid',
  ).length
  steps.push(step('Mandó la foto pedida', photo, leads))
  steps.push(step('Pagó', paid, leads))
  steps.push(step('No pagó', notPaid, leads))
  return steps
}

/**
 * Los ids de mensajes fijos que pidió una fila de `messages.tool_calls`.
 *
 * El jsonb guarda las llamadas tal cual las devolvió OpenAI: `arguments` es un
 * STRING con JSON adentro. Se parsea acá y no con SQL porque el texto de ese
 * string viene con espacios y escapes variables, y un LIKE se equivocaría.
 * Cualquier forma inesperada se ignora: el embudo cuenta, no valida.
 */
export function fixedMessageIdsOf(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return []
  const ids: string[] = []
  for (const call of toolCalls) {
    if (typeof call !== 'object' || call === null) continue
    const fn = (call as { function?: unknown }).function
    if (typeof fn !== 'object' || fn === null) continue
    const { name, arguments: args } = fn as { name?: unknown; arguments?: unknown }
    if (name !== 'send_fixed_message' || typeof args !== 'string') continue
    try {
      const parsed: unknown = JSON.parse(args)
      if (typeof parsed === 'object' && parsed !== null) {
        const message = (parsed as { message?: unknown }).message
        if (typeof message === 'string') ids.push(message)
      }
    } catch {
      // Argumentos rotos: el executor ya los rechazó en su momento.
    }
  }
  return ids
}
