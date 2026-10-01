import { describe, expect, it } from 'vitest'
import { buildFunnel, fixedMessageIdsOf, type QualificationOutcome } from './funnel.js'

// Las etapas de Tecmin, tal cual las declara su archivo.
const STAGES = [
  {
    label: 'Recibió la oferta',
    fixedMessages: ['beneficiosBasico', 'beneficiosMultiple', 'detalleCert1a2'],
  },
  {
    label: 'Recibió el pago o el pedido del DNI',
    fixedMessages: ['pagoBasico', 'pagoCertificacion'],
  },
]

function call(name: string, args: unknown): unknown {
  return { id: 'x', type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

describe('buildFunnel', () => {
  it('cuenta conversaciones por etapa, con el % sobre los leads', () => {
    const steps = buildFunnel({
      stages: STAGES,
      conversationIds: ['a', 'b', 'c', 'd'],
      fixedSent: new Map([
        ['a', new Set(['beneficiosBasico', 'descuentoBasico', 'pagoBasico'])],
        ['b', new Set(['detalleCert1a2', 'pagoCertificacion'])],
        ['c', new Set(['beneficiosMultiple'])],
      ]),
      sentPhoto: new Set(['a', 'b']),
      qualification: new Map<string, QualificationOutcome>([
        ['a', 'paid'],
        ['b', 'pending'],
      ]),
    })

    expect(steps).toEqual([
      { label: 'Leads', count: 4, pct: 100 },
      { label: 'Recibió la oferta', count: 3, pct: 75 },
      { label: 'Recibió el pago o el pedido del DNI', count: 2, pct: 50 },
      { label: 'Mandó la foto pedida', count: 2, pct: 50 },
      { label: 'Pagó', count: 1, pct: 25 },
      { label: 'No pagó', count: 0, pct: 0 },
    ])
  })

  it('no cuenta lo que pasó en conversaciones fuera de la cohorte del período', () => {
    const steps = buildFunnel({
      stages: STAGES,
      conversationIds: ['a'],
      fixedSent: new Map([['vieja', new Set(['pagoBasico'])]]),
      sentPhoto: new Set(['vieja']),
      qualification: new Map<string, QualificationOutcome>([['vieja', 'paid']]),
    })
    expect(steps.map((s) => s.count)).toEqual([1, 0, 0, 0, 0, 0])
  })

  it('sin leads, todo en 0 y sin dividir por cero', () => {
    const steps = buildFunnel({
      stages: STAGES,
      conversationIds: [],
      fixedSent: new Map(),
      sentPhoto: new Set(),
      qualification: new Map(),
    })
    expect(steps.every((s) => s.count === 0 && s.pct === 0)).toBe(true)
  })
})

describe('fixedMessageIdsOf', () => {
  it('saca el id de cada send_fixed_message, aunque venga junto a otras herramientas', () => {
    const toolCalls = [
      call('advance_flow', { branch: 'ruta-cierre' }),
      call('send_fixed_message', { message: 'beneficiosMultiple', service: 'OPERACIÓN MÚLTIPLE' }),
      call('send_fixed_message', { message: 'descuentoMultiple', service: 'OPERACIÓN MÚLTIPLE' }),
    ]
    expect(fixedMessageIdsOf(toolCalls)).toEqual(['beneficiosMultiple', 'descuentoMultiple'])
  })

  it('ignora formas inesperadas en vez de romper', () => {
    expect(fixedMessageIdsOf(null)).toEqual([])
    expect(fixedMessageIdsOf('texto')).toEqual([])
    expect(
      fixedMessageIdsOf([
        { function: { name: 'send_fixed_message', arguments: '{roto' } },
        { function: { name: 'send_fixed_message', arguments: '{"service":"X"}' } },
        42,
      ]),
    ).toEqual([])
  })
})
