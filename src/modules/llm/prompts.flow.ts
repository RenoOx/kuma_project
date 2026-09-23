// The contract every flow type's prompt file fills.
//
// Each field is a place in the business layer of the prompt where a clinic and
// an institute are told different things. Being an interface is the point: a
// slot added for one flow type does not compile until the other one says what
// it gets there — even if the answer is nothing. `[con material]` reached a
// customer because a rule existed on one side only.

// Los ejemplos que el prompt usa para ilustrar una regla, por nicho.
//
// Hasta acá los bloques de reglas generales venían con ejemplos dentales
// escritos a mano — endodoncia, blanqueamiento, ortodoncia — y los recibía TODO
// negocio. Una barbería leía en cada request cómo derivar una endodoncia, y el
// modelo termina hablando del rubro de los ejemplos y no del suyo.
//
// Son ejemplos de FORMATO, no un catálogo: los servicios reales siempre salen
// de "Servicios disponibles". Por eso cada campo es un tratamiento típico del
// rubro y nada los conecta con lo que este negocio ofrece de verdad.
export interface NicheExamples {
  /** Servicio típico del rubro que sí se ofrece pero necesita verse primero. */
  evaluated: string
  /** Otro, para el segundo ejemplo del mismo bloque. */
  evaluatedAlt: string
  /** Lista corta de tratamientos que suelen requerir evaluación. */
  evaluatedList: string
  /** Servicio típico del rubro que este negocio NO ofrece. */
  notOffered: string
  /** Dos que sí, para ofrecer en su lugar. */
  offeredInstead: string
  /** Servicio de precio cerrado, con su monto, para el ejemplo de precio fijo. */
  fixedPrice: { service: string; amount: string }
  /** Servicio de precio en rango, para el ejemplo de "no metas evaluación". */
  rangePrice: { service: string; from: string; to: string; emoji: string }
}

export interface FlowPrompt {
  /** What to always put in bold, in the WhatsApp format block. */
  boldRule: string
  /** Worked bold examples after the shared price one. */
  boldExtraExamples: string[]
  /** The worked confirmation message closing the format block. */
  confirmationExample: string[]
  /** Date reasoning, booking order and name rules — or just "no repreguntes". */
  mechanics: string[]
  /** The ❌/✅ pair that tells a service price from a deposit. */
  priceVsDepositExample: string[]
  /** Price shapes numbered BEFORE the four every business shares. */
  leadingPriceRules: string[][]
  /** Lines after the numbered price shapes. */
  priceRulesClosing: string[]
  /** The diagnostic-consultation blocks. */
  evaluationBlocks: (ex: NicheExamples) => string[]
  /** "# Servicios no reconocidos". */
  unrecognizedService: (ex: NicheExamples) => string[]
  /** General rule 7: cancel, reschedule or undo. */
  cancelRule: string
  /** Rotating the stock phrase that invites the customer to move forward. */
  varyPhrasing: string
  /** The reply to a single vague word. */
  ambiguousReply: string
  /** "Disponibilidad — SIEMPRE de la tool". */
  availabilityFreshness: string[]
}
