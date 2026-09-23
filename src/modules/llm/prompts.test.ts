import { describe, expect, it } from 'vitest'
import type { Business } from '@/db/schema/index.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { businessSettingsSchema } from '@/modules/business/business.settings.js'
import { CTA_VARIANTS } from './prompts.appointments.js'
import { buildSystemPrompt, GREETING_VARIANTS, pickGreeting, renderNodeBlock } from './prompts.js'
import { SALES_CTA_VARIANTS } from './prompts.sales.js'

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

  it('does not offer a diagnostic consultation to a business with no agenda', () => {
    // The other half of the same contract. A consultation is an appointment, so
    // a business that books nothing cannot honour the offer — and the model
    // makes it anyway when the worked examples are in front of it.
    const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings({ flowType: 'sales' }))
    expect(prompt).not.toContain('consulta de evaluación')
    expect(prompt).not.toContain('consulta de diagnóstico')
  })

  it('does not print the evaluation flag for a business with no agenda, even if stored', () => {
    // The fixture's second service carries requiresEvaluation. The panel no
    // longer offers that switch to a selling business, but one that switched
    // flows keeps whatever it saved before — and printing "requiere evaluación
    // previa" with the rules that explain it gated off leaves the model to
    // invent a pricing policy.
    const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings({ flowType: 'sales' }))
    expect(prompt).not.toContain('requiere evaluación previa')
    // The floor it had survives as an ordinary open-ended price.
    expect(prompt).toContain('- Alisado — desde S/ 200')
  })

  it('still prints it for a business that books', () => {
    const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings())
    expect(prompt).toContain('desde S/ 200 (requiere evaluación previa)')
  })
})

describe('a business that sells is never told how to book', () => {
  const sales = fakeSettings({ flowType: 'sales' })

  it('closes with an invitation it can actually honour', () => {
    // "¿Quieres reservar?" went out to an institute answering "¿qué cursos
    // tienen?". Every CTA_VARIANT is a booking invitation, and the picker only
    // branched on appointmentMode — which assistantFunctionFields pins to
    // appointments_only for a selling business, so the branch never fired.
    const prompt = buildSystemPrompt(fakeBusiness(), [], sales)
    // Minus the one both sets share on purpose — "¿Te ayudo con algo más?" asks
    // nobody to book anything, so it is valid in either flow. Asserting against
    // the raw CTA_VARIANTS made this test fail one run in three, which is the
    // test being wrong about the claim, not the code.
    const bookingOnly = CTA_VARIANTS.filter((v) => !SALES_CTA_VARIANTS.includes(v))
    expect(bookingOnly.length).toBeGreaterThan(0)
    for (const variant of bookingOnly) {
      expect(prompt, variant).not.toContain(variant)
    }
    expect(SALES_CTA_VARIANTS.some((v) => prompt.includes(v))).toBe(true)
  })

  it('drops the machinery for tools it is never offered', () => {
    // llm.service filters the tool list by state, so a selling business is never
    // given check_availability or book_appointment. Sending the procedure for
    // calling them taught the model a move it could not make.
    const prompt = buildSystemPrompt(fakeBusiness(), [], sales)
    expect(prompt).not.toContain('# Reserva — el orden es obligatorio')
    expect(prompt).not.toContain('# Confirmación de citas pendientes')
    expect(prompt).not.toContain('obligatorio antes de agendar')
    expect(prompt).not.toContain('book_appointment')
    expect(prompt).not.toContain('check_availability')
  })

  it('keeps the rules that are not about booking at all', () => {
    // The gate has to be surgical: a closed catalogue and not asking twice are
    // true in any conversation, and a business that sells needs them more, not
    // less — a plausible-sounding course is exactly what gets invented.
    const prompt = buildSystemPrompt(fakeBusiness(), [], sales)
    expect(prompt).toContain('# Servicios no reconocidos')
    expect(prompt).toContain('# No repreguntes lo que el cliente ya te dijo')
    expect(prompt).toContain('NUNCA inventes un número de Yape')
  })

  it('still gives all of it to a business that books', () => {
    const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings())
    expect(prompt).toContain('# Reserva — el orden es obligatorio')
    expect(prompt).toContain('# Confirmación de citas pendientes')
    expect(prompt).toContain('check_availability')
    expect(CTA_VARIANTS.some((v) => prompt.includes(v))).toBe(true)
  })
})

describe('what a service is, in words', () => {
  it('keeps the description OUT of the catalogue index', () => {
    // This used to assert the opposite, and the reason it gave was true at the
    // time: the catalogue line was the only place Emma could read a description,
    // so without it "contame más" could only be answered with the price the
    // customer already had.
    //
    // That premise is gone. show_services and send_service_media both return the
    // description in full now, so the detail has a home that the index does not
    // have to be. Leaving it here as well was actively harmful: with a summary
    // in hand the model wrote the detail from memory instead of asking, and what
    // reached a customer was its paraphrase — facts dropped, and once a S/ 100
    // course announced as free.
    //
    // The index is an index. The detail comes from the tools, verbatim.
    const prompt = buildSystemPrompt(
      fakeBusiness(),
      [],
      fakeSettings({
        services: [
          {
            name: 'Corte',
            priceMin: 25,
            priceMax: 25,
            active: true,
            description: 'Incluye lavado y peinado.',
          },
        ],
      }),
    )
    expect(prompt).not.toContain('Incluye lavado y peinado.')
    // And the line stays readable: the model still knows what exists and what it
    // costs, which is what it needs to pick one and ask about it.
    expect(prompt).toContain('- Corte — S/ 25')
  })

  it('names the services that have files on their own line, never inside one', () => {
    // "[con material]" used to sit glued to the name and the price. A model
    // copying that line copied the marker with it, and it reached a customer
    // twice — the second time after a rule had been written forbidding exactly
    // that. A ban on copying something that lives inside the thing being copied
    // is a ban that fails, so the marker moved out of the line.
    const prompt = buildSystemPrompt(
      fakeBusiness(),
      [],
      fakeSettings({
        services: [{ name: 'Corte', id: 'svc1', priceMin: 25, priceMax: 25, active: true }],
      }),
      [],
      null,
      new Set(['svc1']),
    )
    expect(prompt).toContain('- Corte — S/ 25')
    expect(prompt).not.toContain('- Corte — S/ 25 [con material]')
    expect(prompt).toContain('Tienen material cargado: Corte')
  })

  it('leaves no empty line for a service that has none', () => {
    const prompt = buildSystemPrompt(fakeBusiness(), [], fakeSettings())
    // No dangling indented line under the entry when there is nothing to put there.
    const line = prompt.split('\n').find((l) => l.startsWith('- Corte'))
    expect(line).toBe('- Corte — S/ 25')
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

  it('gives the premises hours as information, not as a limit', () => {
    // This used to print "atiende las 24 horas, todos los días" and drop the
    // schedule, which told an institute's students the doors were open at 3am.
    // Two separate facts: EMMA answers at any hour, the LOCAL opens when it
    // opens. Only the first one is 24/7.
    const prompt = buildSystemPrompt(fakeBusiness(), [], salesSettings)
    expect(prompt).toContain('## Horario de atención en el local')
    expect(prompt).toContain('SOLO informativo')
    expect(prompt).not.toContain('atiende las 24 horas')
  })

  it('keeps the agenda mechanics out of that block', () => {
    // Special days and the slot length are both about filling a calendar, and
    // there is no calendar here.
    const prompt = buildSystemPrompt(fakeBusiness(), [], salesSettings)
    expect(prompt).not.toContain('Duración del slot')
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

  it('does not put a duration next to a service it will never book', () => {
    // A course has no length anything reserves. Left in, the model quotes it at
    // the customer as if it meant something.
    const withDuration = fakeSettings({
      flowType: 'sales',
      services: [{ name: 'Certificación', priceMin: 300, durationMinutes: 45, active: true }],
    })
    const prompt = buildSystemPrompt(fakeBusiness(), [], withDuration)
    expect(prompt).toContain('Certificación')
    expect(prompt).not.toContain('45 min')
  })

  it('keeps the duration for a business that does book', () => {
    const prompt = buildSystemPrompt(
      fakeBusiness(),
      [],
      fakeSettings({
        services: [{ name: 'Corte', priceMin: 25, durationMinutes: 45, active: true }],
      }),
    )
    expect(prompt).toContain('45 min')
  })
})
