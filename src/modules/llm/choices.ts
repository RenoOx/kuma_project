import type { StepChoiceOption, StepChoices } from '@/modules/conversation/stateMachine.js'

// La elección de una opción (`choices` de un paso) la hace el código, no la IA:
// en Tecmin (2026-10-06) la IA ofreció la certificación de 5 o más para 2
// máquinas, con gpt-4o-mini y con gpt-4.1-mini. Contar y mapear una letra son
// cuentas; acá viven como funciones puras para poder probarlas.

/** Minúsculas, sin tildes ni signos, espacios simples. */
export function normalizeChoiceText(text: string): string {
  return normalize(text)
}

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
 * letra ("A", "la b", "opción C", "c."), un número si las opciones se llaman
 * por número ("2", "2️⃣", "la 2", "opción 3") o un tramo ("1 a 2", "de 3 a 4",
 * "5 o más", "5+"). Cualquier otra cosa —"no tengo experiencia, la A", "la A y
 * la B", una pregunta— devuelve null y la lee la IA, que entiende el contexto.
 */
export function parseChoice(
  text: string,
  options: ReadonlyArray<StepChoiceOption>,
): StepChoiceOption | null {
  const t = normalize(text)
  if (t === '') return null

  // "2️⃣" llega acá como "2": normalize borra el selector y el recuadro del emoji.
  // "dos" también, con keyOf.
  const single = t.match(/^(?:(?:la|el)\s+)?(?:(?:opcion|numero)\s+)?([a-z]+|\d{1,2})$/)
  if (single?.[1]) {
    const key = keyOf(single[1])
    const found = options.find((o) => o.key.toUpperCase() === key)
    // Un número que no es la key de ninguna opción no decide nada acá: en un
    // negocio con letras, "2" solo sigue yendo a la IA, como antes.
    if (found || !/\d/.test(key)) return found ?? null
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

// "no quiero el título" no elige el título: una negación justo antes de la
// palabra clave (hasta 3 palabras) la anula.
const NEGATIONS = new Set(['no', 'ni', 'tampoco', 'nunca'])
const NEGATION_REACH = 3

/** Dónde empieza `phrase` (tokens) dentro de `tokens`, todas las veces. */
function phraseStarts(tokens: ReadonlyArray<string>, phrase: ReadonlyArray<string>): number[] {
  const starts: number[] = []
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((word, j) => tokens[i + j] === word)) starts.push(i)
  }
  return starts
}

/**
 * La opción cuyas palabras clave (`words`) nombra el mensaje, si nombra las de
 * UNA sola. "Quiero obtener un título" → la opción del Título, sin la IA: con
 * la IA eligiendo, una vez escribió su propia oferta con el Yape (Tecmin, prod,
 * 2026-10-26). Dos opciones nombradas, o una negada ("no quiero el título"),
 * no deciden nada acá: lo lee la IA.
 */
export function choiceByWords(
  text: string,
  options: ReadonlyArray<StepChoiceOption>,
): StepChoiceOption | null {
  const tokens = normalize(text).split(' ')
  const named = options.filter((option) =>
    (option.words ?? []).some((word) =>
      phraseStarts(tokens, word.split(' ')).some(
        (start) =>
          !tokens.slice(Math.max(0, start - NEGATION_REACH), start).some((t) => NEGATIONS.has(t)),
      ),
    ),
  )
  return named.length === 1 ? (named[0] ?? null) : null
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

const DURATION_UNIT = /^(?:anos?|mes|meses|semanas?|dias?)$/

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  quince: 15,
  veinte: 20,
  treinta: 30,
  cuarenta: 40,
}

/**
 * La key que nombra un token: "dos" → "2", "b" → "B". Las opciones de Tecmin
 * son números y los alumnos también los escriben en letras ("uno", "tres").
 * "un" y "una" no: casi siempre son artículos ("una certificación").
 */
function keyOf(token: string): string {
  const spelled = /^[a-z]{2,}$/.test(token) && !ARTICLES.has(token) ? numberOf(token) : null
  return (spelled === null ? token : String(spelled)).toUpperCase()
}

function numberOf(token: string): number | null {
  if (/^\d+$/.test(token)) return Number(token)
  return NUMBER_WORDS[token] ?? null
}

/**
 * Si la cantidad que pasó la IA es, en el mensaje del cliente, un TIEMPO y no
 * cuántas cosas: "20 años" respondiendo a "1 a 2 / 3 a 4 / 5 o más máquinas"
 * terminó en la oferta de 5 o más (Tecmin, 2026-10-10). Es tiempo si el número
 * solo aparece pegado a años, meses, semanas o días; si también aparece suelto
 * o con otra palabra ("20 años operando 2 máquinas" → el 2), cuenta.
 */
export function isDurationCount(n: number, customerText: string): boolean {
  const tokens = normalize(customerText)
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(' ')
  let asDuration = false
  let asOther = false
  tokens.forEach((token, i) => {
    if (numberOf(token) !== n) return
    if (DURATION_UNIT.test(tokens[i + 1] ?? '')) asDuration = true
    else asOther = true
  })
  return asDuration && !asOther
}

// Letras que en español también son palabras ("voy a", "sí o no"): como opción
// solo cuentan con algo delante que las marque ("la a", "opción a").
const LETTER_WORDS = new Set(['a', 'e', 'o', 'u', 'y'])
const LETTER_MARKERS = new Set(['la', 'el', 'opcion', 'letra'])
// "un/una" son artículos casi siempre ("cuánto cuesta un certificado").
const ARTICLES = new Set(['un', 'una'])

/** Las palabras del nombre de una opción que ninguna otra opción tiene. */
function ownWords(name: string, others: ReadonlyArray<string>): string[] {
  const shared = new Set(others.flatMap((other) => normalize(other).split(' ')))
  return normalize(name)
    .split(' ')
    .filter((word) => word.length >= 4 && !shared.has(word))
}

/**
 * Si el mensaje del cliente dice CUÁL quiere, de alguna forma: una letra de las
 * opciones, un número (que no sea un tiempo), o una palabra propia del nombre de
 * una opción ("básico"). Sin nada de eso, una letra que pase la IA la inventó
 * ella: "¿cuánto me costaría el certificado?" terminó en la oferta de la A
 * (Tecmin, 2026-10-10). `options` lleva el nombre del servicio de cada opción.
 */
export function hasChoiceSignal(
  customerText: string,
  options: ReadonlyArray<{ key: string; name: string; words?: ReadonlyArray<string> }>,
): boolean {
  const tokens = normalize(customerText)
    .replace(/(\d)([a-z])/g, '$1 $2')
    .split(' ')
    .filter((token) => token !== '')
  const keys = new Set(options.map((o) => o.key.toLowerCase()))

  // Una key numérica pegada a un tiempo ("tengo 1 año") no nombra la opción 1.
  const namesLetter = tokens.some(
    (token, i) =>
      keys.has(token) &&
      !DURATION_UNIT.test(tokens[i + 1] ?? '') &&
      (!LETTER_WORDS.has(token) || tokens.length === 1 || LETTER_MARKERS.has(tokens[i - 1] ?? '')),
  )
  if (namesLetter) return true

  const namesNumber = tokens.some(
    (token, i) =>
      !ARTICLES.has(token) && numberOf(token) !== null && !DURATION_UNIT.test(tokens[i + 1] ?? ''),
  )
  if (namesNumber) return true

  const words = new Set(tokens)
  // Las palabras clave de una opción (`words`) también dicen cuál.
  const text = tokens.join(' ')
  const namesKeyword = options.some((option) =>
    (option.words ?? []).some((word) => ` ${text} `.includes(` ${word} `)),
  )
  if (namesKeyword) return true
  return options.some((option) =>
    ownWords(
      option.name,
      options.filter((other) => other !== option).map((other) => other.name),
    ).some((word) => words.has(word)),
  )
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
  // La IA puede pasar la opción como la escribió el cliente ("dos").
  const opcion = understood.opcion ? normalize(understood.opcion) : ''
  const key = opcion ? keyOf(opcion) : ''
  return key ? (options.find((o) => o.key.toUpperCase() === key) ?? null) : null
}
