import type { StepChoiceOption, StepChoices } from '@/modules/conversation/stateMachine.js'

// La elección de una opción (`choices` de un paso) la hace el código, no la IA:
// en Tecmin (2026-10-06) la IA ofreció la certificación de 5 o más para 2
// máquinas, con gpt-4o-mini y con gpt-4.1-mini. Contar y mapear una letra son
// cuentas; acá viven como funciones puras para poder probarlas.

/** Minúsculas, sin tildes ni signos, espacios simples. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9+ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * La opción que el cliente eligió, si su mensaje es SOLO una elección: una
 * letra ("A", "la b", "opción C", "c.") o un tramo ("1 a 2", "de 3 a 4",
 * "5 o más", "5+"). Cualquier otra cosa —"no tengo experiencia, la A", "la A y
 * la B", una pregunta— devuelve null y la lee la IA, que entiende el contexto.
 */
export function parseChoice(
  text: string,
  options: ReadonlyArray<StepChoiceOption>,
): StepChoiceOption | null {
  const t = normalize(text)
  if (t === '') return null

  const letter = t.match(/^(?:(?:la|el)\s+)?(?:opcion\s+)?([a-z])$/)
  if (letter) {
    const key = letter[1]?.toUpperCase()
    return options.find((o) => o.key.toUpperCase() === key) ?? null
  }

  // Un tramo se reconoce por su primer número, que es el inicio de un rango.
  const range = t.match(/^(?:de\s+)?(\d+)\s*(?:a\s*(\d+)|o\s+mas|a\s+mas|\+|mas)$/)
  if (range) {
    const from = Number(range[1])
    const to = range[2] === undefined ? null : Number(range[2])
    return (
      options.find((o) => o.count && o.count[0] === from && (to === null || o.count[1] === to)) ??
      null
    )
  }

  return null
}

/** La opción cuyo rango de cantidad incluye `n`, o null si ninguna. */
export function optionForCount(
  n: number,
  options: ReadonlyArray<StepChoiceOption>,
): StepChoiceOption | null {
  if (!Number.isInteger(n) || n < 1) return null
  return (
    options.find((o) => o.count && n >= o.count[0] && (o.count[1] === null || n <= o.count[1])) ??
    null
  )
}

/**
 * Cuántas cosas distintas nombró el cliente. La IA solo las lista; el código
 * cuenta, sin repetidas ni vacías ("retroexcavadora" dos veces cuenta una).
 */
export function countDistinct(items: ReadonlyArray<string>): number {
  return new Set(items.map(normalize).filter((item) => item !== '')).size
}

/** Un paso con `choices`, como lo ve `currentChoice`. */
export interface ChoiceStep {
  step: string
  choices: StepChoices
}

/** La elección vigente: qué opción, de qué paso. */
export interface CurrentChoice {
  step: string
  choices: StepChoices
  option: StepChoiceOption
}

/** Los ids de mensajes fijos que pidió una fila de `messages.tool_calls`, en orden. */
function fixedMessageIdsIn(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return []
  const ids: string[] = []
  for (const call of toolCalls) {
    const fn = (call as { function?: { name?: unknown; arguments?: unknown } })?.function
    if (fn?.name !== 'send_fixed_message' || typeof fn.arguments !== 'string') continue
    try {
      const message = (JSON.parse(fn.arguments) as { message?: unknown }).message
      if (typeof message === 'string') ids.push(message)
    } catch {
      // Una fila rota no decide nada: se sigue con la anterior.
    }
  }
  return ids
}

/**
 * La última opción elegida en la conversación, leída del historial: el último
 * mensaje fijo que es de UNA sola opción. Los que comparten varias opciones
 * (ej. "¿Realizamos tus certificados?", que mandan las tres certificaciones) no
 * dicen cuál fue, y se saltan. `rows`, del más nuevo al más viejo.
 *
 * Sin columna nueva: elegir deja en el historial los send_fixed_message de la
 * oferta (ver llm.service), y una corrección posterior deja los suyos, más
 * nuevos.
 */
export function currentChoice(
  rows: ReadonlyArray<{ toolCalls: unknown }>,
  steps: ReadonlyArray<ChoiceStep>,
): CurrentChoice | null {
  const owners = new Map<string, CurrentChoice[]>()
  for (const { step, choices } of steps) {
    for (const option of choices.options) {
      for (const id of option.send) {
        owners.set(id, [...(owners.get(id) ?? []), { step, choices, option }])
      }
    }
  }
  for (const row of rows) {
    const ids = fixedMessageIdsIn(row.toolCalls)
    for (let i = ids.length - 1; i >= 0; i--) {
      const found = owners.get(ids[i] ?? '')
      if (found?.length === 1 && found[0]) return found[0]
    }
  }
  return null
}

/**
 * La opción según lo que entendió la IA (`elegir_opcion`). Si dio lo que el
 * cliente nombró o cuántas, MANDA EL CONTEO del código, aunque la IA también
 * haya pasado una letra: en dev (2026-10-06) anotó bien "retroexcavadora,
 * minicargador" y agregó por su cuenta la opción B. La letra sola cuenta solo
 * cuando no hay nada que contar (los cursos: "el básico" → A).
 */
export function pickOption(
  understood: { opcion?: string; cantidad?: number; elementos?: ReadonlyArray<string> },
  options: ReadonlyArray<StepChoiceOption>,
): StepChoiceOption | null {
  const counted =
    understood.elementos && understood.elementos.length > 0
      ? countDistinct(understood.elementos)
      : understood.cantidad
  const hasCounts = options.some((o) => o.count)
  if (counted !== undefined && hasCounts) return optionForCount(counted, options)
  const key = understood.opcion?.trim().toUpperCase()
  return key ? (options.find((o) => o.key.toUpperCase() === key) ?? null) : null
}
