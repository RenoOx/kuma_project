import type { StepChoiceOption } from '@/modules/conversation/stateMachine.js'

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
