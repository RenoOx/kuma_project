import type { Business } from '@/db/schema/index.js'
import { describe, expect, it } from 'vitest'
import { buildSystemPrompt, GREETING_VARIANTS, pickGreeting } from './prompts.js'

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
    googleMapsUrl: null,
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
