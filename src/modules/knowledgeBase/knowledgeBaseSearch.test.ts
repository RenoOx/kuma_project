import { db } from '@/db/client.js'
import { knowledgeBase, type NewKnowledgeBaseEntry } from '@/db/schema/index.js'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, resetDb, seedTwoBusinesses } from '../../../tests/helpers/db.js'
import { searchByCategory, searchBySimilarity } from './knowledgeBaseSearch.service.js'

async function seedEntries(entries: NewKnowledgeBaseEntry[]): Promise<void> {
  await db.insert(knowledgeBase).values(entries)
}

describe('knowledgeBaseSearch.searchByCategory', () => {
  let businessAId: string
  let businessBId: string

  beforeEach(async () => {
    await resetDb()
    const seed = await seedTwoBusinesses()
    businessAId = seed.businessA.id
    businessBId = seed.businessB.id
  })

  afterAll(async () => {
    await closeDb()
  })

  it('loads only the detected category', async () => {
    await seedEntries([
      { businessId: businessAId, title: 'Dirección', category: 'ubicacion', content: 'Av. Larco 123' },
      { businessId: businessAId, title: 'Corte', category: 'precios', content: 'S/30' },
    ])

    const result = await searchByCategory(businessAId, '¿dónde quedan?')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.matchedCategories[0]).toBe('ubicacion')
    expect(result.data.entries.map((e) => e.title)).toEqual(['Dirección'])
  })

  it('orders by priority descending', async () => {
    await seedEntries([
      { businessId: businessAId, title: 'Baja', category: 'precios', content: 'c', priority: 1 },
      { businessId: businessAId, title: 'Alta', category: 'precios', content: 'a', priority: 10 },
      { businessId: businessAId, title: 'Media', category: 'precios', content: 'b', priority: 5 },
    ])

    const result = await searchByCategory(businessAId, 'cuánto cuesta')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.entries.map((e) => e.title)).toEqual(['Alta', 'Media', 'Baja'])
  })

  it('excludes inactive entries', async () => {
    await seedEntries([
      { businessId: businessAId, title: 'Vigente', category: 'precios', content: 'S/30' },
      {
        businessId: businessAId,
        title: 'Vieja',
        category: 'precios',
        content: 'S/20',
        active: false,
      },
    ])

    const result = await searchByCategory(businessAId, 'cuánto cuesta')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.entries.map((e) => e.title)).toEqual(['Vigente'])
  })

  it('caps the detected category at the limit', async () => {
    await seedEntries(
      Array.from({ length: 8 }, (_, i) => ({
        businessId: businessAId,
        title: `Precio ${i}`,
        category: 'precios' as const,
        content: `S/${i}`,
        priority: 8 - i,
      })),
    )

    const result = await searchByCategory(businessAId, 'cuánto cuesta')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.entries).toHaveLength(5)
    expect(result.data.entries.map((e) => e.title)).toEqual([
      'Precio 0',
      'Precio 1',
      'Precio 2',
      'Precio 3',
      'Precio 4',
    ])
  })

  it("includes send_mode='always' entries even when their category was not detected", async () => {
    await seedEntries([
      { businessId: businessAId, title: 'Dirección', category: 'ubicacion', content: 'Av. Larco' },
      {
        businessId: businessAId,
        title: 'Formas de pago',
        category: 'politicas',
        content: 'Yape y Plin',
        sendMode: 'always',
      },
    ])

    const result = await searchByCategory(businessAId, '¿dónde quedan?')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.entries.map((e) => e.title).sort()).toEqual(['Dirección', 'Formas de pago'])
  })

  it("includes a trigger_based entry only when its keywords hit the message", async () => {
    await seedEntries([
      {
        businessId: businessAId,
        title: 'Estacionamiento',
        category: 'ubicacion',
        content: 'Hay cochera en el sótano',
        sendMode: 'trigger_based',
        triggerKeywords: ['estacionamiento', 'cochera'],
      },
    ])

    const hit = await searchByCategory(businessAId, '¿tienen estacionamiento?')
    expect(hit.ok).toBe(true)
    if (hit.ok) expect(hit.data.entries.map((e) => e.title)).toEqual(['Estacionamiento'])

    // "dónde quedan" routes to `ubicacion`, but a trigger_based entry must stay
    // out until one of its own keywords appears.
    const miss = await searchByCategory(businessAId, '¿dónde quedan?')
    expect(miss.ok).toBe(true)
    if (miss.ok) expect(miss.data.entries).toEqual([])
  })

  it('falls back to top entries by priority when no category is detected', async () => {
    await seedEntries([
      { businessId: businessAId, title: 'Alta', category: 'precios', content: 'a', priority: 9 },
      { businessId: businessAId, title: 'Baja', category: 'ubicacion', content: 'b', priority: 1 },
    ])

    const result = await searchByCategory(businessAId, 'hola buenas tardes')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.matchedCategories).toEqual([])
    expect(result.data.entries.map((e) => e.title)).toEqual(['Alta', 'Baja'])
  })

  it('never returns entries belonging to another business', async () => {
    await seedEntries([
      { businessId: businessAId, title: 'Precio A', category: 'precios', content: 'S/30' },
      { businessId: businessBId, title: 'Precio B', category: 'precios', content: 'S/50' },
      {
        businessId: businessBId,
        title: 'Siempre B',
        category: 'politicas',
        content: 'B policy',
        sendMode: 'always',
      },
    ])

    const resultA = await searchByCategory(businessAId, 'cuánto cuesta')
    expect(resultA.ok).toBe(true)
    if (!resultA.ok) return
    expect(resultA.data.entries.map((e) => e.title)).toEqual(['Precio A'])
    for (const entry of resultA.data.entries) {
      expect(entry.businessId).toBe(businessAId)
    }

    const resultB = await searchByCategory(businessBId, 'cuánto cuesta')
    expect(resultB.ok).toBe(true)
    if (!resultB.ok) return
    expect(resultB.data.entries.map((e) => e.title).sort()).toEqual(['Precio B', 'Siempre B'])
    for (const entry of resultB.data.entries) {
      expect(entry.businessId).toBe(businessBId)
    }
  })

  it('returns an empty list for a business with no entries', async () => {
    const result = await searchByCategory(businessAId, 'cuánto cuesta')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.entries).toEqual([])
  })
})

describe('knowledgeBaseSearch.searchBySimilarity', () => {
  it('fails loudly instead of silently returning nothing', async () => {
    const result = await searchBySimilarity('any-business', [0.1, 0.2, 0.3])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('kb_semantic_search_not_implemented')
  })
})
