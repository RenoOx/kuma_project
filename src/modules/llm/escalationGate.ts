// El portero de la escalada (Instituto Tecmin, 2026-10-01).
//
// Pedirle al modelo "no escales cuando el cliente dice que sí" falló dos veces
// seguidas en producción: "SI CLARO, ¿DAN FACTURA BOLETA?" y "Si claro dan
// boleta descuento?" terminaron en "Te paso con un asesor" en vez del mensaje
// de pago, y la conversación salió del flujo. Lo mismo que con `fixedOnly`: lo
// que una instrucción no garantiza, lo decide el código.
//
// Con el portero, escalate_to_human solo se ejecuta si hay un motivo real en el
// MENSAJE DEL CLIENTE (no en lo que el modelo cree): pide una persona, es una
// empresa, un reclamo… — las palabras las pone el archivo del negocio — o
// insiste en algo que Emma ya derivó al asesor. Sin motivo, la llamada vuelve
// rechazada y el modelo sigue el turno: avanza o responde.
//
// Puro a propósito: se testea sin base ni OpenAI.

export interface EscalationGate {
  /** Motivos reales, ya compilados. Se comparan contra el texto sin tildes y en minúsculas. */
  patterns: readonly RegExp[]
  /**
   * La frase con la que Emma deriva una pregunta al asesor. Si su mensaje
   * anterior la tenía y el cliente vuelve a escribir, es la segunda vez:
   * insiste, y eso sí es motivo.
   */
  insistAfter: string
}

export type EscalationDecision =
  | { allowed: true; reason: 'pattern' | 'insist'; match: string }
  | { allowed: false; reason: 'no_reason' }

/** Sin tildes, en minúsculas y con los espacios colapsados: "Llámame" y "llamame" son lo mismo. */
export function normalizeForGate(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

export function escalationAllowed(input: {
  customerText: string
  previousAssistantText: string | null
  gate: EscalationGate
}): EscalationDecision {
  const customer = normalizeForGate(input.customerText)
  for (const pattern of input.gate.patterns) {
    const found = customer.match(pattern)
    if (found) return { allowed: true, reason: 'pattern', match: found[0] }
  }

  const insistAfter = normalizeForGate(input.gate.insistAfter)
  if (
    insistAfter !== '' &&
    input.previousAssistantText !== null &&
    normalizeForGate(input.previousAssistantText).includes(insistAfter)
  ) {
    return { allowed: true, reason: 'insist', match: input.gate.insistAfter }
  }

  return { allowed: false, reason: 'no_reason' }
}

/**
 * Lo que recibe el modelo cuando la escalada se rechaza. Le dice qué hacer en
 * su lugar, porque un "no" pelado lo deja escribiendo de memoria. La frase para
 * lo que no sabe es la del negocio (`insistAfter`): la misma que, si el cliente
 * insiste, después sí deja escalar.
 */
export function escalationNotWarrantedInstruction(gate: EscalationGate): string {
  return `No escales: el cliente no pidió una persona ni hay otro motivo para pasarlo a una. Si aceptó o eligió algo, aunque pregunte otra cosa, avanza con advance_flow por la ruta que corresponde a este paso y no respondas esas preguntas. Si es dudoso, responde corto y vuelve a la pregunta del paso. Si no sabes la respuesta: "${gate.insistAfter}".`
}
