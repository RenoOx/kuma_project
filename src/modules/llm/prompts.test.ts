import { describe, expect, it } from 'vitest'
import type { Business } from '@/db/schema/index.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'
import { buildSystemPrompt, GREETING_VARIANTS, pickGreeting, renderNodeBlock } from './prompts.js'

const BUSINESS_NAME = 'Bella Vida Salón & Spa'

function fakeBusiness(overrides: Partial<Business> = {}): Business {
  return {
    id: 'biz-1',
    name: BUSINESS_NAME,
    whatsappNumber: '+51900000000',
    timezone: 'America/Lima',
    systemPrompt: null,
    settings: {},
    ownerWhatsappNumber: null,
    ownerName: null,
    address: null,
    googleMapsUrl: null,
    panelToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

describe('GREETING_VARIANTS', () => {
  it('has at least 5 variations', () => {
    expect(GREETING_VARIANTS.length).toBeGreaterThanOrEqual(5)
  })

  it('every variant mentions the business name and the wave emoji', () => {
    for (const variant of GREETING_VARIANTS) {
      const text = variant(BUSINESS_NAME)
      expect(text).toContain(BUSINESS_NAME)
      expect(text).toContain('👋')
    }
  })

  it('all variants are textually distinct', () => {
    const texts = GREETING_VARIANTS.map((v) => v(BUSINESS_NAME))
    expect(new Set(texts).size).toBe(texts.length)
  })
})

describe('pickGreeting', () => {
  it('selects each variant deterministically given a fixed randomFn', () => {
    const n = GREETING_VARIANTS.length
    for (let i = 0; i < n; i++) {
      // randomFn returning i/n lands Math.floor(randomFn() * n) on index i.
      const result = pickGreeting(BUSINESS_NAME, () => i / n)
      expect(result).toBe(GREETING_VARIANTS[i]?.(BUSINESS_NAME))
    }
  })

  it('falls back to the first variant if randomFn returns 0', () => {
    expect(pickGreeting(BUSINESS_NAME, () => 0)).toBe(GREETING_VARIANTS[0]?.(BUSINESS_NAME))
  })
})

describe('buildSystemPrompt greeting instructions', () => {
  it('embeds the exact picked greeting text as a literal instruction', () => {
    const business = fakeBusiness()
    const prompt = buildSystemPrompt(business, [], null)

    const matches = GREETING_VARIANTS.filter((variant) => prompt.includes(variant(BUSINESS_NAME)))
    expect(matches.length).toBe(1)
  })

  it('instructs the model to use the greeting exactly, not paraphrase it', () => {
    const business = fakeBusiness()
    const prompt = buildSystemPrompt(business, [], null)

    expect(prompt).toContain('sin modificarlo ni parafrasearlo')
  })
})

// ── The layer boundary ───────────────────────────────────────────────────────
//
// The prompt is split in three: what belongs to the BUSINESS (cacheable), what
// belongs to the TURN, and what belongs to the NODE. Moving the flow prose down
// into the nodes is what cut ~22% off every message — and it is also the change
// that could silently drop a rule, because a rule that moves into a node only
// reaches the states that node is in. These tests pin what must NOT move.

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

function fakeSettings(overrides: Record<string, unknown> = {}): BusinessSettings {
  return businessSettingsSchema.parse({
    niche: 'barberia',
    bookingMode: 'direct',
    slotDurationMinutes: 30,
    operatingHours: Object.fromEntries(
      DAYS.map((d) => [d, { closed: false, open: '09:00', close: '18:00' }]),
    ),
    services: [
      { name: 'Corte', priceMin: 25, priceMax: 25, active: true },
      { name: 'Alisado', requiresEvaluation: true, priceMin: 200, active: true },
    ],
    flowType: 'appointments',
    requiresDeposit: false,
    ...overrides,
  })
}

const NICHES = ['dental', 'barberia', 'estetica', 'salud', 'general'] as const

const WITH_DEPOSIT = {
  requiresDeposit: true,
  depositAmount: 'S/ 20',
  depositPaymentMethods: [{ method: 'yape', number: '987654321', holder: 'Juan' }],
}

describe('the diagnosis path survives in every state', () => {
  it('keeps the evaluation rules in the business layer, for all niches', () => {
    // A service marked `requiresEvaluation` makes Emma offer a diagnostic
    // consultation. It hangs off a per-service flag, so it has to reach EVERY
    // state: a customer who opens with "¿cuánto cuesta el alisado?" never passes
    // through the catalogue step, and tying the rule there would lose it.
    for (const niche of NICHES) {
      const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings({ niche }))
      expect(prompt, niche).toContain('requiere evaluación previa')
      expect(prompt, niche).toContain('consulta de evaluación')
    }
  })

  it('keeps the rule that stops Emma inventing an evaluation where there is none', () => {
    const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings())
    expect(prompt).toContain('Servicios que NO requieren evaluación')
  })
})

describe('payment rules reach every niche', () => {
  // These used to live inside clinicalBlocks, which only dental and salud got.
  // A barbershop that charged a deposit received two other copies of the deposit
  // rules and never this one — so it was the only kind of business whose Emma
  // was never told when to call request_image, the call that makes the capture
  // reach the owner at all.

  it('tells every niche when to call request_image', () => {
    for (const niche of NICHES) {
      const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings({ niche, ...WITH_DEPOSIT }))
      expect(prompt, niche).toContain('request_image')
    }
  })

  it('says it once, not three times', () => {
    const prompt = buildSystemPrompt(
      fakeBusiness(),
      [],
      fakeSettings({ niche: 'dental', ...WITH_DEPOSIT }),
    )
    expect(prompt.split('request_image').length - 1).toBe(1)
  })

  it('forbids inventing an account number even with no deposit configured', () => {
    // Regression caught by the before/after diff: merging the three copies into
    // depositOrderBlock dropped this for businesses that charge nothing, because
    // that block only renders when there IS a deposit.
    for (const niche of NICHES) {
      const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings({ niche }))
      expect(prompt, niche).toContain('inventes un número de Yape')
    }
  })
})

describe('the flow prose left the business layer', () => {
  it('no longer ships the five-step booking flow in every message', () => {
    const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings())
    expect(prompt).not.toContain('PASO 4 — Adelanto')
    expect(prompt).not.toContain('Toda reserva sigue estos 5 pasos')
  })

  it('keeps the invariant the steps hang off', () => {
    const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings())
    expect(prompt).toContain('servicio → horario → nombre')
  })
})

describe('renderNodeBlock', () => {
  it('renders nothing for a node with no objective, not an empty header', () => {
    expect(renderNodeBlock({ objective: '', steps: [], edgeCases: [], example: '' })).toBe('')
  })

  it('lays out the four fields', () => {
    const block = renderNodeBlock({
      objective: 'Saludar.',
      steps: ['Primero esto.', 'Después lo otro.'],
      edgeCases: ['Cliente apurado.'],
      example: 'Hola, soy Emma.',
    })
    expect(block).toContain('OBJETIVO: Saludar.')
    expect(block).toContain('1. Primero esto.')
    expect(block).toContain('2. Después lo otro.')
    expect(block).toContain('- Cliente apurado.')
    expect(block).toContain('Hola, soy Emma.')
  })

  it('labels the example as a tone reference, never as text to copy', () => {
    // A model handed a verbatim string sends it verbatim, and then every
    // customer of that business gets the same sentence.
    const block = renderNodeBlock({ objective: 'x', steps: [], edgeCases: [], example: 'Hola.' })
    expect(block).toContain('NO lo copies literal')
  })

  it('omits a section the node left empty', () => {
    const block = renderNodeBlock({ objective: 'x', steps: [], edgeCases: [], example: '' })
    expect(block).not.toContain('PASOS')
    expect(block).not.toContain('CASOS ESPECIALES')
    expect(block).not.toContain('EJEMPLO')
  })
})

describe('a selling business is always open', () => {
  const salesSettings = fakeSettings({ flowType: 'sales', outOfHoursEnabled: true })

  it('says so instead of printing a weekly schedule', () => {
    const prompt = buildSystemPrompt(fakeBusiness(), [], salesSettings)
    expect(prompt).toContain('atiende las 24 horas')
    expect(prompt).not.toContain('## Horarios')
  })

  it('never tells the customer it is closed, whatever the toggle says', () => {
    // Somebody buying a course at 3am is a sale, not a customer who has to come
    // back tomorrow. An out-of-hours toggle left on must not cost that sale.
    const prompt = buildSystemPrompt(fakeBusiness(), [], salesSettings)
    expect(prompt).not.toContain('FUERA DE HORARIO')
  })

  it('still prints the schedule for a business that books appointments', () => {
    const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings())
    expect(prompt).toContain('## Horarios')
  })
})
