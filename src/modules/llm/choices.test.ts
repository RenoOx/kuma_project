import { describe, expect, it } from 'vitest'
import type { StepChoiceOption } from '@/modules/conversation/stateMachine.js'
import { countDistinct, currentChoice, optionForCount, parseChoice } from './choices.js'

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
