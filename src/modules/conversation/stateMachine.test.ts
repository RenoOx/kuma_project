import { describe, expect, it } from 'vitest'
import type { BusinessSettings, FlowType } from '@/modules/business/business.settings.js'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'
import { EMITTED_TRIGGERS, IDLE_TRIGGER, NODE_CATALOG, nodesForFlow } from './nodeCatalog.js'
import {
  compileFlow,
  type FlowComposition,
  getNextState,
  getStateConfig,
  INITIAL_STATE,
  presetFor,
  validateFlow,
} from './stateMachine.js'

// These are the tests that make "a saved flow is a flow that runs" a claim
// rather than a hope. The bug they exist to prevent already shipped once: six
// triggers declared in the state machine that nothing emitted, which left a
// selling business answering one message and then going silent forever. It was
// invisible for months because nothing ever walked the graph.

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

function settings(overrides: Record<string, unknown> = {}): BusinessSettings {
  return businessSettingsSchema.parse({
    niche: 'barberia',
    bookingMode: 'direct',
    slotDurationMinutes: 30,
    operatingHours: Object.fromEntries(
      DAYS.map((d) => [d, { closed: false, open: '09:00', close: '18:00' }]),
    ),
    services: [{ name: 'Corte', priceMin: 25, priceMax: 25, active: true }],
    flowType: 'appointments',
    requiresDeposit: false,
    ...overrides,
  })
}

const WITH_DEPOSIT = {
  requiresDeposit: true,
  depositAmount: 'S/ 20',
  depositPaymentMethods: [{ method: 'yape', number: '987654321', holder: 'Juan' }],
}

/** Every node the flow can actually be walked into, starting from idle. */
function reachable(composition: FlowComposition, flowType: FlowType): Set<string> {
  const flow = compileFlow(composition, flowType)
  const seen = new Set([INITIAL_STATE])
  const queue = [INITIAL_STATE]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const next of Object.values(flow[current]?.transitions ?? {})) {
      if (!seen.has(next)) {
        seen.add(next)
        queue.push(next)
      }
    }
  }
  return seen
}

describe('the node catalogue', () => {
  it('only declares exits whose trigger something in the code emits', () => {
    // The check that would have caught the six dead triggers. If this fails,
    // either add the emitter or drop the exit — a declared route nobody can
    // take is worse than no route, because it reads as working.
    const orphans: string[] = []
    // Cada tipo de flujo con sus extensiones: las salidas de agenda de los nodos
    // core viven ahí, no en NODE_CATALOG.
    for (const bp of [...nodesForFlow('appointments'), ...nodesForFlow('sales')]) {
      for (const trigger of Object.keys(bp.exits)) {
        if (!EMITTED_TRIGGERS.has(trigger)) orphans.push(`${bp.id} → ${trigger}`)
      }
    }
    expect(orphans).toEqual([])
  })

  it('never jumps to a node that is not in the catalogue', () => {
    const ids = new Set(NODE_CATALOG.map((n) => n.id))
    const broken: string[] = []
    for (const bp of [...nodesForFlow('appointments'), ...nodesForFlow('sales')]) {
      for (const [trigger, target] of Object.entries(bp.exits)) {
        if (target !== 'next' && !ids.has(target.node)) {
          broken.push(`${bp.id} → ${trigger} → ${target.node}`)
        }
      }
    }
    expect(broken).toEqual([])
  })

  it('has unique ids', () => {
    const ids = NODE_CATALOG.map((n) => n.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('presetFor', () => {
  it('drops the payment steps when the business charges no deposit', () => {
    const nodes = presetFor(settings()).nodes
    expect(nodes).not.toContain('await_payment')
    expect(nodes).not.toContain('await_payment_verification')
  })

  it('includes them when it does', () => {
    const nodes = presetFor(settings(WITH_DEPOSIT)).nodes
    expect(nodes).toContain('await_payment')
    expect(nodes).toContain('await_payment_verification')
  })

  it('gives a selling business a flow that runs, since its own is not built yet', () => {
    // Deliberate: sales is missing the tool that records "the customer accepted
    // and wants to pay". Until it exists, an informational flow that works beats
    // a selling one that stalls — which is what shipped before.
    const nodes = presetFor(settings({ flowType: 'sales' })).nodes
    expect(nodes).toContain('greeting')
    expect(nodes).not.toContain('await_payment')
  })

  it('every preset it produces is valid and fully reachable', () => {
    const cases: Array<[string, BusinessSettings]> = [
      ['sin adelanto', settings()],
      ['con adelanto', settings(WITH_DEPOSIT)],
      ['sales', settings({ flowType: 'sales' })],
      ['con captura de datos', settings({ ...WITH_DEPOSIT, collectDataFields: ['nombre'] })],
    ]
    for (const [label, s] of cases) {
      const preset = presetFor(s)
      const checked = validateFlow(preset, s)
      expect(checked.ok, `${label}: ${checked.ok ? '' : checked.error.userMessage}`).toBe(true)
      const reached = reachable(preset, s.flowType)
      for (const id of preset.nodes) {
        expect(reached.has(id), `${label}: "${id}" es inalcanzable`).toBe(true)
      }
    }
  })
})

describe('compileFlow', () => {
  it("resolves 'next' to whatever the owner put after the node", () => {
    const flow = compileFlow(
      { nodes: ['idle', 'greeting', 'informing', 'listado_servicios'], overrides: {} },
      'appointments',
    )
    // greeting advances on the customer's next message; the target is the node
    // that follows it in the list, not one named in the blueprint.
    expect(flow.greeting?.transitions.customer_message).toBe('informing')
    expect(flow.informing?.transitions.services_listed).toBe('listado_servicios')
  })

  it('drops a jump whose target the owner did not include', () => {
    const flow = compileFlow(
      { nodes: ['idle', 'greeting', 'confirmed'], overrides: {} },
      'appointments',
    )
    // greeting declares a jump to show_availability, which is not composed here.
    expect(flow.greeting?.transitions.asks_availability).toBeUndefined()
    expect(flow.greeting?.transitions.appointment_booked).toBe('confirmed')
  })
  it('gives every node but idle a way back to idle, and no blueprint can opt out', () => {
    const flow = compileFlow(presetFor(settings()), 'appointments')
    for (const [id, config] of Object.entries(flow)) {
      if (id === INITIAL_STATE) continue
      expect(config.transitions[IDLE_TRIGGER], `${id}`).toBe(INITIAL_STATE)
    }
  })

  it('lets the owner override the example and the edge cases', () => {
    const flow = compileFlow(
      {
        nodes: ['idle', 'greeting'],
        overrides: { greeting: { example: 'Buenas, soy Emma.', edgeCases: ['Cliente apurado.'] } },
      },
      'appointments',
    )
    expect(flow.greeting?.node.example).toBe('Buenas, soy Emma.')
    expect(flow.greeting?.node.edgeCases).toEqual(['Cliente apurado.'])
  })

  it('never lets an override reach the objective or the steps', () => {
    // The motor is not the owner's. An override that could rewrite the steps
    // would let the panel silently disable a rule the code depends on.
    const base = compileFlow({ nodes: ['idle', 'greeting'], overrides: {} }, 'appointments')
    const overridden = compileFlow(
      {
        nodes: ['idle', 'greeting'],
        // biome-ignore lint/suspicious/noExplicitAny: forcing a shape the type forbids is the point
        overrides: { greeting: { objective: 'otra cosa', steps: [] } as any },
      },
      'appointments',
    )
    expect(overridden.greeting?.node.objective).toBe(base.greeting?.node.objective)
    expect(overridden.greeting?.node.steps).toEqual(base.greeting?.node.steps)
  })

  it('skips an unknown node id instead of throwing mid-conversation', () => {
    const flow = compileFlow(
      { nodes: ['idle', 'greeting', 'nodo_fantasma'], overrides: {} },
      'appointments',
    )
    expect(Object.keys(flow)).toEqual(['idle', 'greeting'])
  })
})

describe('validateFlow', () => {
  it('refuses a node whose configuration is missing', () => {
    const r = validateFlow(
      { nodes: ['idle', 'greeting', 'await_payment', 'confirmed'], overrides: {} },
      settings(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.userMessage).toContain('Métodos de pago')
  })

  it('refuses a flow with no greeting', () => {
    const r = validateFlow({ nodes: ['idle', 'listado_servicios'], overrides: {} }, settings())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.userMessage).toContain('Saludo inicial')
  })

  it('refuses a flow that does not start at idle', () => {
    const r = validateFlow({ nodes: ['greeting', 'idle'], overrides: {} }, settings())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.userMessage).toContain('primer paso')
  })

  it('refuses an unreachable node', () => {
    // En un negocio de venta: correccion_datos es de venta, y en una clínica el
    // validador lo rechazaría antes por ser del otro tipo, no por inalcanzable.
    const r = validateFlow(
      { nodes: ['idle', 'greeting', 'confirmed', 'correccion_datos'], overrides: {} },
      settings({ flowType: 'sales', collectDataFields: ['nombre'] }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.userMessage).toContain('inalcanzable')
  })

  it('refuses a repeated node', () => {
    const r = validateFlow(
      { nodes: ['idle', 'greeting', 'greeting', 'confirmed'], overrides: {} },
      settings(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.userMessage).toContain('repetido')
  })

  it('refuses a node that does not exist', () => {
    const r = validateFlow({ nodes: ['idle', 'greeting', 'nada'], overrides: {} }, settings())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.userMessage).toContain('no existe')
  })

  it('names the step in a message the owner can act on', () => {
    // The rejection is shown verbatim in the panel, so it has to say which step
    // broke and why — not "datos inválidos".
    const r = validateFlow(
      { nodes: ['idle', 'greeting', 'await_payment', 'confirmed'], overrides: {} },
      settings(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.userMessage).toMatch(/"[^"]+"/)
      expect(r.error.code).toBe('invalid_conversation_flow')
    }
  })
})

describe('the deposit guard', () => {
  const flow = compileFlow(presetFor(settings(WITH_DEPOSIT)), 'appointments')

  it('refuses entry to await_payment without proof of a frozen booking', () => {
    const next = getNextState(flow, 'show_availability', 'deposit_required')
    expect(next).toBe('show_availability')
  })

  it('lets it through when the emitter can prove it', () => {
    const next = getNextState(flow, 'show_availability', 'deposit_required', {
      bookingIntent: true,
    })
    expect(next).toBe('await_payment')
  })

  it('lets a rejected payment back to await_payment — with evidence', () => {
    // The bug this pins: paymentVerification.service used to apply
    // payment_rejected with no evidence, the guard refused it, and the customer
    // stayed in await_payment_verification, whose only tool is escalation and
    // whose prompt forbids asking for another capture.
    expect(getNextState(flow, 'await_payment_verification', 'payment_rejected')).toBe(
      'await_payment_verification',
    )
    expect(
      getNextState(flow, 'await_payment_verification', 'payment_rejected', {
        bookingIntent: true,
      }),
    ).toBe('await_payment')
  })
})

describe('getNextState', () => {
  const flow = compileFlow(presetFor(settings()), 'appointments')

  it('stays put on a trigger the node does not list', () => {
    expect(getNextState(flow, 'greeting', 'payment_approved')).toBe('greeting')
  })

  it('lifts a new conversation off idle on the first message', () => {
    expect(getNextState(flow, INITIAL_STATE, 'customer_message')).toBe('greeting')
  })

  it('sends a returning customer back to the greeting', () => {
    expect(getNextState(flow, 'confirmed', 'customer_message')).toBe('greeting')
  })
})

describe('getStateConfig', () => {
  const flow = compileFlow(presetFor(settings()), 'appointments')

  it('falls back to idle for a state the flow no longer defines', () => {
    // Happens for real: the owner removes a step while a conversation sits in
    // it. The thread restarts rather than dying.
    expect(getStateConfig(flow, 'un_estado_viejo')).toBe(flow.idle)
  })

  it('offers no tool the executor cannot run', () => {
    const known = new Set([
      'check_availability',
      'book_appointment',
      'confirm_pending_appointment',
      'send_service_media',
      'request_image',
      'escalate_to_human',
      'show_services',
      'save_customer_data',
      'confirm_summary',
      'correct_field',
    ])
    for (const config of Object.values(flow)) {
      for (const tool of config.tools) expect(known.has(tool), tool).toBe(true)
    }
  })
})
