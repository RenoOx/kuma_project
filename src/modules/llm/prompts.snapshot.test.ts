import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Business } from '@/db/schema/index.js'
import { FLOW_FIXTURES } from '@/modules/conversation/flowFixtures.testutil.js'
import { compileFlow, presetFor } from '@/modules/conversation/stateMachine.js'
import { buildSystemPrompt, renderNodeBlock } from './prompts.js'

// The prompt every kind of business receives, byte for byte. This is the net
// under any change to prompts.ts or the node catalogue: a fix aimed at the
// selling flow that alters what a clinic reads fails here, in a fixture it was
// never meant to touch.
//
// Clock and randomness are pinned so the greeting, the CTA and the date line are
// the same on every run — otherwise the snapshot would be testing Math.random.

const business: Business = {
  id: 'biz-snapshot',
  name: 'Negocio de Prueba',
  whatsappNumber: '+51900000000',
  timezone: 'America/Lima',
  systemPrompt: null,
  settings: {},
  ownerWhatsappNumber: null,
  ownerName: null,
  address: 'Av. Siempre Viva 123',
  googleMapsUrl: null,
  panelToken: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-23T15:00:00Z'))
  vi.spyOn(Math, 'random').mockReturnValue(0)
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('business + turn layers', () => {
  for (const [name, settings] of FLOW_FIXTURES) {
    it(name, () => {
      expect(buildSystemPrompt(business, [], settings)).toMatchSnapshot()
    })
  }

  it('appointments/dental with an owner-proposed pending appointment', () => {
    const settings = FLOW_FIXTURES.find(([n]) => n === 'appointments/dental')?.[1] ?? null
    const pending = {
      service: 'Corte',
      scheduledAtDisplay: 'jueves 25 de septiembre, 3:00pm',
      proposedByOwner: true,
    }
    expect(buildSystemPrompt(business, [], settings, [], pending)).toMatchSnapshot()
  })

  it('appointments/dental with a pending appointment awaiting approval', () => {
    const settings = FLOW_FIXTURES.find(([n]) => n === 'appointments/dental')?.[1] ?? null
    const pending = {
      service: 'Corte',
      scheduledAtDisplay: 'jueves 25 de septiembre, 3:00pm',
      proposedByOwner: false,
    }
    expect(buildSystemPrompt(business, [], settings, [], pending)).toMatchSnapshot()
  })

  it('sales/fields with captured customer facts', () => {
    const settings = FLOW_FIXTURES.find(([n]) => n === 'sales/fields')?.[1] ?? null
    const facts = { 'nombre completo': 'Ana Torres', correo: 'ana@example.com' }
    expect(buildSystemPrompt(business, [], settings, [], null, new Set(), facts)).toMatchSnapshot()
  })
})

describe('node layer', () => {
  for (const [name, settings] of FLOW_FIXTURES) {
    it(name, () => {
      const flow = compileFlow(presetFor(settings))
      const blocks = Object.fromEntries(
        Object.entries(flow).map(([state, config]) => [
          state,
          renderNodeBlock(config.node, config.branches),
        ]),
      )
      expect(blocks).toMatchSnapshot()
    })
  }
})
