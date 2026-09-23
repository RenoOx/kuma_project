import { describe, expect, it } from 'vitest'
import type { BusinessSettings, FlowType } from '@/modules/business/business.settings.js'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'
import { compositionFor } from '@/modules/conversation/flowSource.js'
import { presetFor, validateFlow } from '@/modules/conversation/stateMachine.js'
import plantilla from './_plantilla.js'
import { type BusinessConfig, defineBusinessConfig } from './define.js'
import { BUSINESS_CONFIGS } from './index.js'

// A repo file wins over the database, so a broken one must never reach a merge:
// these run in `npm run check` for every file listed in index.ts, plus the
// template everyone copies from.

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

/** A business of this flow type with every node requirement met. */
function settingsFor(
  flowType: FlowType,
  overrides: Record<string, unknown> = {},
): BusinessSettings {
  return businessSettingsSchema.parse({
    niche: 'general',
    bookingMode: 'direct',
    slotDurationMinutes: 30,
    operatingHours: Object.fromEntries(
      DAYS.map((d) => [d, { closed: false, open: '09:00', close: '18:00' }]),
    ),
    services: [{ name: 'Curso básico', priceMin: 450, priceMax: 450, active: true }],
    flowType,
    requiresDeposit: true,
    depositAmount: 'S/ 20',
    depositPaymentMethods: [{ method: 'yape', number: '987654321', holder: 'Juan' }],
    collectDataFields: ['nombre completo', 'DNI'],
    ...overrides,
  })
}

const ALL_FILES: ReadonlyArray<BusinessConfig> = [...BUSINESS_CONFIGS, plantilla]

describe('business config files', () => {
  it('never register two files for the same business', () => {
    const ids = BUSINESS_CONFIGS.map((c) => c.businessId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  for (const config of ALL_FILES) {
    it(`${config.name} is a flow that runs`, () => {
      const checked = validateFlow(config.composition, settingsFor(config.flowType))
      expect(checked.ok, checked.ok ? '' : checked.error.userMessage).toBe(true)
    })
  }

  it('turns the readable steps into the stored composition shape', () => {
    const config = defineBusinessConfig({
      businessId: 'biz-a',
      name: 'A',
      flowType: 'appointments',
      flow: [{ node: 'idle' }, { node: 'greeting', example: 'Hola' }, { node: 'confirmed' }],
    })
    expect(config.composition).toEqual({
      nodes: ['idle', 'greeting', 'confirmed'],
      overrides: { greeting: { example: 'Hola' } },
    })
  })

  it('does not compile a node of the other flow type', () => {
    defineBusinessConfig({
      businessId: 'biz-typecheck',
      name: 'typecheck only',
      flowType: 'sales',
      // @ts-expect-error — show_availability belongs to appointments, not sales
      flow: [{ node: 'idle' }, { node: 'greeting' }, { node: 'show_availability' }],
    })
  })
})

describe('compositionFor', () => {
  const fileA = defineBusinessConfig({
    businessId: 'biz-a',
    name: 'A',
    flowType: 'sales',
    flow: [
      { node: 'idle' },
      { node: 'greeting', example: 'Solo de A' },
      { node: 'informing' },
      { node: 'listado_servicios' },
    ],
  })
  const configs = new Map([[fileA.businessId, fileA]])

  it('applies a business its own file', () => {
    const resolved = compositionFor('biz-a', settingsFor('sales'), configs)
    expect(resolved.source).toBe('file')
    expect(resolved.composition).toBe(fileA.composition)
  })

  it('never applies one business the file of another', () => {
    const settings = settingsFor('sales')
    const resolved = compositionFor('biz-b', settings, configs)
    expect(resolved.source).toBe('preset')
    expect(resolved.composition).toEqual(presetFor(settings))
    expect(resolved.fileSkipped).toBeUndefined()
  })

  it('falls back to what the panel saved for a business without a file', () => {
    const stored = { nodes: ['idle', 'greeting', 'informing', 'listado_servicios'], overrides: {} }
    const resolved = compositionFor(
      'biz-b',
      settingsFor('sales', { conversationFlow: stored }),
      configs,
    )
    expect(resolved.source).toBe('stored')
    expect(resolved.composition).toEqual(stored)
  })

  it('skips a file whose flow type disagrees with the database, and says why', () => {
    const resolved = compositionFor('biz-a', settingsFor('appointments'), configs)
    expect(resolved.source).not.toBe('file')
    expect(resolved.fileSkipped).toContain('flowType')
  })

  it('skips a file that no longer validates against the current config', () => {
    // listado_servicios needs an active service; the owner switched them all off.
    const inactive = [{ name: 'Curso básico', priceMin: 450, priceMax: 450, active: false }]
    const resolved = compositionFor('biz-a', settingsFor('sales', { services: inactive }), configs)
    expect(resolved.source).not.toBe('file')
    expect(resolved.fileSkipped).toContain('listado_servicios')
  })
})
