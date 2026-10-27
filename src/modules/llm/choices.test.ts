import { describe, expect, it } from 'vitest'
import type { StepChoiceOption } from '@/modules/conversation/stateMachine.js'
import {
  choiceByWords,
  countDistinct,
  currentChoice,
  hasChoiceSignal,
  isDurationCount,
  offeredOption,
  optionForCount,
  parseChoice,
  pickOption,
} from './choices.js'

// Las certificaciones de Tecmin: el caso que nació esto (2026-10-06).
const certs: StepChoiceOption[] = [
  { key: 'A', serviceId: 'a', send: ['m1'], count: [1, 2] },
  { key: 'B', serviceId: 'b', send: ['m2'], count: [3, 4] },
  { key: 'C', serviceId: 'c', send: ['m3'], count: [5, null] },
]
// Los cursos: letras sin rangos.
const courses: StepChoiceOption[] = [
  { key: 'A', serviceId: 'x', send: ['b1'] },
  { key: 'B', serviceId: 'y', send: ['b2'] },
  { key: 'C', serviceId: 'z', send: ['b3'] },
]

describe('parseChoice', () => {
  it.each([
    ['A', 'A'],
    ['b', 'B'],
    ['la b', 'B'],
    ['La C.', 'C'],
    ['opción C', 'C'],
    ['Opcion a', 'A'],
    ['  c  ', 'C'],
  ])('reads the letter in %j', (text, key) => {
    expect(parseChoice(text, certs)?.key).toBe(key)
  })

  it.each([
    ['1 a 2', 'A'],
    ['de 3 a 4', 'B'],
    ['5 o más', 'C'],
    ['5 a mas', 'C'],
    ['5+', 'C'],
  ])('reads the range in %j', (text, key) => {
    expect(parseChoice(text, certs)?.key).toBe(key)
  })

  // Lo que no es SOLO una elección lo lee la IA, que entiende el contexto.
  it.each([
    'no tengo experiencia, la A',
    'la A y la B',
    '¿cuánto cuesta la A?',
    'retroexcavadora y minicargador',
    '2',
    'D',
    'hola',
    '',
  ])('leaves %j to the model', (text) => {
    expect(parseChoice(text, certs)).toBeNull()
  })

  it('does not read a range on options without counts', () => {
    expect(parseChoice('1 a 2', courses)).toBeNull()
    expect(parseChoice('b', courses)?.key).toBe('B')
  })
})

describe('optionForCount', () => {
  it.each([
    [1, 'A'],
    [2, 'A'],
    [3, 'B'],
    [4, 'B'],
    [5, 'C'],
    [12, 'C'],
  ])('%i machines is option %s', (n, key) => {
    expect(optionForCount(n, certs)?.key).toBe(key)
  })

  it.each([0, -1, 1.5])('has no option for %d', (n) => {
    expect(optionForCount(n, certs)).toBeNull()
  })

  it('has no option when the options have no counts', () => {
    expect(optionForCount(2, courses)).toBeNull()
  })
})

describe('countDistinct', () => {
  it('counts what was named, without repeats or blanks', () => {
    expect(countDistinct(['retroexcavadora', 'minicargador'])).toBe(2)
    expect(countDistinct(['Retroexcavadora', 'retroexcavadora ', ''])).toBe(1)
    expect(countDistinct(['Excavadora', 'cargador frontal', 'retroexcavadora'])).toBe(3)
  })
})

describe('currentChoice', () => {
  // Las certificaciones comparten "pregunta": ese mensaje no dice cuál fue.
  const certSteps = [
    {
      step: 'asesoria_perfil',
      choices: {
        route: 'quiere-certificarse',
        options: [
          {
            key: 'A',
            serviceId: 'a',
            send: ['detalle1a2', 'pregunta'],
            count: [1, 2] as [number, number],
          },
          {
            key: 'B',
            serviceId: 'b',
            send: ['detalle3a4', 'pregunta'],
            count: [3, 4] as [number, number],
          },
        ],
      },
    },
    {
      step: 'listado_servicios',
      choices: {
        route: 'ruta-cierre',
        options: [{ key: 'A', serviceId: 'x', send: ['beneficiosBasico', 'descuentoBasico'] }],
      },
    },
  ]
  const sent = (...messages: string[]) => ({
    toolCalls: messages.map((message) => ({
      type: 'function',
      function: {
        name: 'send_fixed_message',
        arguments: JSON.stringify({ message, service: 's' }),
      },
    })),
  })

  it('is null without any choice in the history', () => {
    expect(currentChoice([], certSteps)).toBeNull()
    expect(currentChoice([sent('presentacion'), { toolCalls: null }], certSteps)).toBeNull()
  })

  it('finds the option of the last offer, skipping messages shared by several options', () => {
    const found = currentChoice([sent('detalle1a2', 'pregunta')], certSteps)
    expect([found?.step, found?.option.key]).toEqual(['asesoria_perfil', 'A'])
  })

  it('follows a later correction (rows newest first)', () => {
    const found = currentChoice(
      [sent('pagoCertificacion'), sent('detalle3a4', 'pregunta'), sent('detalle1a2', 'pregunta')],
      certSteps,
    )
    expect(found?.option.key).toBe('B')
  })

  it('tells a course from a certification with the same letter', () => {
    const found = currentChoice([sent('beneficiosBasico', 'descuentoBasico')], certSteps)
    expect([found?.step, found?.option.serviceId]).toEqual(['listado_servicios', 'x'])
  })

  it('skips a broken row instead of failing', () => {
    const broken = { toolCalls: [{ function: { name: 'send_fixed_message', arguments: '{nope' } }] }
    expect(currentChoice([broken, sent('detalle1a2')], certSteps)?.option.key).toBe('A')
  })
})

describe('pickOption', () => {
  it('counts what was named even when the model also passed a letter', () => {
    // El caso real (dev, 2026-10-06): anotó bien las máquinas y agregó "B".
    const picked = pickOption(
      { elementos: ['retroexcavadora', 'minicargador'], opcion: 'B' },
      certs,
    )
    expect(picked?.key).toBe('A')
  })

  it('uses the count the client gave', () => {
    expect(pickOption({ cantidad: 4 }, certs)?.key).toBe('B')
  })

  it('uses the letter when there is nothing to count', () => {
    expect(pickOption({ opcion: 'b' }, certs)?.key).toBe('B')
    expect(pickOption({ opcion: 'C', cantidad: 2 }, courses)?.key).toBe('C')
  })

  it('has no option when nothing fits', () => {
    expect(pickOption({}, certs)).toBeNull()
    expect(pickOption({ elementos: [] }, certs)).toBeNull()
    expect(pickOption({ opcion: 'Z' }, courses)).toBeNull()
  })
})

// Tecmin, 2026-10-10: "20 años" (de experiencia) terminó en la oferta de 5 o más.
describe('isDurationCount', () => {
  it('treats a number tied to a time unit as a duration', () => {
    expect(isDurationCount(20, '20 años')).toBe(true)
    expect(isDurationCount(20, 'Tengo 20 años de experiencia')).toBe(true)
    expect(isDurationCount(20, '20años')).toBe(true)
    expect(isDurationCount(20, 'veinte años')).toBe(true)
    expect(isDurationCount(3, 'hace 3 meses')).toBe(true)
    expect(isDurationCount(1, 'un año nomás')).toBe(true)
  })

  it('keeps a real count', () => {
    expect(isDurationCount(2, '2 máquinas')).toBe(false)
    expect(isDurationCount(5, '5')).toBe(false)
    expect(isDurationCount(3, 'unas tres')).toBe(false)
    expect(isDurationCount(1, 'una máquina')).toBe(false)
  })

  it('counts the number that is not a duration in the same message', () => {
    expect(isDurationCount(2, '20 años operando 2 máquinas')).toBe(false)
    expect(isDurationCount(20, '20 años operando 2 máquinas')).toBe(true)
  })

  it('does not block a number the customer never wrote', () => {
    expect(isDurationCount(2, 'retroexcavadora y minicargador')).toBe(false)
  })
})

// Tecmin, 2026-10-10: "¿cuánto me costaría el certificado?" terminó en la oferta
// de la A, una letra que el cliente nunca dijo. Nombres tal cual están en prod.
describe('hasChoiceSignal', () => {
  const certNames = [
    { key: 'A', name: 'Certificación - 1 a 2 maquinarias' },
    { key: 'B', name: 'Certificación - 3 a 4 maquinarias' },
    { key: 'C', name: 'Certificación - 5 maquinarias o más' },
  ]
  const courseNames = [
    { key: 'A', name: 'BÁSICO - Operación y mantenimiento de equipos' },
    { key: 'B', name: 'AVANZADO - Operación y mantenimiento de 3 equipos' },
    { key: 'C', name: 'OPERACIÓN MÚLTIPLE Y MANTENIMIENTO DE EQUIPOS' },
  ]

  it('rejects a price question that names no option', () => {
    expect(hasChoiceSignal('Cuanto me costaría  el certificado', certNames)).toBe(false)
    expect(hasChoiceSignal('¿Cuánto cuesta un certificado?', certNames)).toBe(false)
    expect(hasChoiceSignal('A cuánto sale?', certNames)).toBe(false)
    expect(hasChoiceSignal('voy a pensarlo', certNames)).toBe(false)
    expect(hasChoiceSignal('tengo 20 años de experiencia, cuánto es?', certNames)).toBe(false)
    expect(hasChoiceSignal('cuánto cuesta el curso de operación?', courseNames)).toBe(false)
  })

  it('accepts a letter', () => {
    expect(hasChoiceSignal('la B cuánto cuesta', certNames)).toBe(true)
    expect(hasChoiceSignal('opción c', certNames)).toBe(true)
    expect(hasChoiceSignal('c', certNames)).toBe(true)
    expect(hasChoiceSignal('A', certNames)).toBe(true)
    expect(hasChoiceSignal('la a, cuánto es?', certNames)).toBe(true)
  })

  it('accepts a number', () => {
    expect(hasChoiceSignal('opero 2 máquinas', certNames)).toBe(true)
    expect(hasChoiceSignal('Más de 5', certNames)).toBe(true)
    expect(hasChoiceSignal('unas tres', certNames)).toBe(true)
    expect(hasChoiceSignal('el de 3 equipos', courseNames)).toBe(true)
  })

  it('accepts a word only one option has', () => {
    expect(hasChoiceSignal('el básico, ¿hay descuento?', courseNames)).toBe(true)
    expect(hasChoiceSignal('me interesa el avanzado', courseNames)).toBe(true)
    expect(hasChoiceSignal('el multiple', courseNames)).toBe(true)
  })
})

// Tecmin "3 opciones" (2026-10-26): las opciones se llaman 1, 2 y 3, y los
// alumnos también las escriben en letras ("dos", "la tres").
describe('numbered options', () => {
  const numbered: StepChoiceOption[] = [
    { key: '1', serviceId: 'equipo', send: ['op1'], count: [1, 1] },
    { key: '2', serviceId: 'multiple', send: ['op2'], count: [2, null] },
    { key: '3', serviceId: 'titulo', send: ['op3'] },
  ]

  it.each([
    ['2', '2'],
    ['2️⃣', '2'],
    ['la 3', '3'],
    ['opción 1', '1'],
    ['número 2', '2'],
    ['dos', '2'],
    ['Tres', '3'],
    ['la uno', '1'],
    ['opción dos', '2'],
    ['el tres', '3'],
    ['2 o más', '2'],
  ])('resolves "%s" to option %s without the model', (text, key) => {
    expect(parseChoice(text, numbered)?.key).toBe(key)
  })

  it.each([
    'una',
    '4',
    'cuatro',
    'hola',
    'quiero la 2 pero tengo dudas',
  ])('leaves "%s" to the model', (text) => {
    expect(parseChoice(text, numbered)).toBeNull()
  })

  it('does not turn a spelled number into a choice where options are letters', () => {
    expect(parseChoice('dos', courses)).toBeNull()
    expect(parseChoice('2', courses)).toBeNull()
    expect(parseChoice('la b', courses)?.key).toBe('B')
  })

  it('reads the option the model passed, spelled or not', () => {
    expect(pickOption({ opcion: 'dos' }, numbered)?.key).toBe('2')
    expect(pickOption({ opcion: '3' }, numbered)?.key).toBe('3')
    expect(pickOption({ opcion: 'b' }, courses)?.key).toBe('B')
  })

  it('maps machines to options by count: 1 is option 1, 2 or more option 2', () => {
    expect(pickOption({ elementos: ['excavadora'] }, numbered)?.key).toBe('1')
    expect(pickOption({ cantidad: 3 }, numbered)?.key).toBe('2')
    expect(pickOption({ elementos: ['excavadora', 'volquete'] }, numbered)?.key).toBe('2')
  })

  it('does not take a time as the number of an option', () => {
    const names = [
      { key: '1', name: 'Certificación en un equipo' },
      { key: '2', name: 'Certificación de Operador Múltiple' },
      { key: '3', name: 'Título Técnico de Operador - MINEDU' },
    ]
    expect(hasChoiceSignal('tengo 1 año operando', names)).toBe(false)
    expect(hasChoiceSignal('la 2 por favor', names)).toBe(true)
    expect(hasChoiceSignal('la dos', names)).toBe(true)
    expect(hasChoiceSignal('quiero el título', names)).toBe(true)
  })
})

// Tecmin "3 opciones" (2026-10-26): "quiero obtener un título" en prod, y la IA
// armó su propia oferta y su propio cobro. Con `words`, esas frases las elige el
// código. Las palabras ya vienen normalizadas, como las deja `define.ts`.
describe('choiceByWords', () => {
  const withWords: StepChoiceOption[] = [
    {
      key: '1',
      serviceId: 'equipo',
      send: ['op1'],
      count: [1, 1],
      words: ['un equipo', 'una maquina', 'una maquinaria'],
    },
    {
      key: '2',
      serviceId: 'multiple',
      send: ['op2'],
      count: [2, null],
      words: ['multiple', 'varias maquinas', 'varias maquinarias', 'varios equipos'],
    },
    {
      key: '3',
      serviceId: 'titulo',
      send: ['op3'],
      words: ['titulo', 'titulos', 'titularse', 'titularme', 'titulado', 'tecnico'],
    },
  ]

  it.each([
    ['quiero obtener un titulo', '3'],
    ['Quiero el TÍTULO técnico', '3'],
    ['quiero titularme', '3'],
    ['quiero ser operador múltiple', '2'],
    ['opero varias máquinas', '2'],
    ['solo manejo una máquina', '1'],
  ])('chooses "%s" as option %s', (text, key) => {
    expect(choiceByWords(text, withWords)?.key).toBe(key)
  })

  it.each([
    // Dos opciones a la vez: que decida la IA.
    'el título de operador múltiple',
    // Una negación cerca descarta esa frase.
    'no quiero el título',
    'ni el título ni nada',
    // Sin ninguna frase de una opción.
    'tengo 1 año de exp',
    'cuánto cuesta?',
    '¿es del MINEDU?',
    'Tienes exp en maquinaria pesada? Si Quieres certificarte? si',
    // Una frase tiene que estar entera, no pegada a otra palabra.
    'mis titulares',
  ])('leaves "%s" to the model', (text) => {
    expect(choiceByWords(text, withWords)).toBeNull()
  })

  it('takes a phrase further than 3 words from the negation', () => {
    expect(choiceByWords('no sé bien qué hacer, quiero el título', withWords)?.key).toBe('3')
  })

  it('chooses nothing for options without words', () => {
    expect(choiceByWords('el título', courses)).toBeNull()
  })

  it('counts a keyword as a signal for the model choice too', () => {
    const names = withWords.map((o) => ({ key: o.key, name: 'Opción', words: o.words }))
    expect(hasChoiceSignal('quiero titularme', names)).toBe(true)
    expect(hasChoiceSignal('cuánto cuesta?', names)).toBe(false)
  })
})

describe('offeredOption', () => {
  // Las opciones de Tecmin (versión 3 opciones), con los nombres de sus servicios.
  const tecmin = [
    {
      key: '1',
      name: 'Certificación en un equipo',
      words: ['un equipo', 'una maquina', 'una maquinaria'],
    },
    {
      key: '2',
      name: 'Certificación de Operador Múltiple',
      words: ['multiple', 'varias maquinas', 'varias maquinarias', 'varios equipos'],
    },
    {
      key: '3',
      name: 'Título Técnico de Operador - MINEDU',
      words: ['titulo', 'titulos', 'titularse', 'titularme', 'titulado', 'tecnico'],
    },
  ]

  it('la respuesta a "no tengo experiencia" ofrece solo el Título', () => {
    const answer =
      '¡Claro que sí! 🎓 Con la Opción 3 (Título Técnico MINEDU) estudias una carrera formal de 2 años con teoría y práctica, obteniendo tu título oficial a nombre de la nación para postular a las grandes empresas mineras. 🚀\n¿Te gustaría arrancar con tu inscripción de una vez? 😉👇'
    expect(offeredOption(answer, tecmin)).toBe('3')
  })

  it.each([
    [
      'la pregunta de las tres opciones',
      '1️⃣ Certificarme en un equipo.\n2️⃣ Certificarte como Operador Múltiple.\n3️⃣ Obtener tu Título Técnico - MINEDU.\n¡Mándame solo el número 1, 2 o 3 y te paso la opción perfecta para ti! 😉👇',
    ],
    [
      'la diferencia entre la 1 y la 2',
      '¡Excelente pregunta! La diferencia está en tu CV: la Opción 1 te certifica en 1 solo equipo, mientras que la Opción 2 (Operador Múltiple) te certifica en todos los equipos que sabes operar 😃',
    ],
    ['la frase del asesor', 'Esa consulta te la confirma el asesor 😊'],
    ['un tiempo, no una opción', 'Es una carrera de 2 años 😊'],
  ])('no ofrece una sola: %s', (_, text) => {
    expect(offeredOption(text, tecmin)).toBeNull()
  })
})
