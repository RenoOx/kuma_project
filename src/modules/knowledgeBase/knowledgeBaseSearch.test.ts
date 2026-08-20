import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/client.js'
import { knowledgeBase, type NewKnowledgeBaseEntry } from '@/db/schema/index.js'
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
      {
        businessId: businessAId,
        title: 'Historia',
        category: 'informacion_general',
        content: 'Abrimos en 2015',
      },
      {
        businessId: businessAId,
        title: 'Combo',
        category: 'promociones',
        content: '2x1 los martes',
      },
    ])

    const result = await searchByCategory(businessAId, '¿tienen alguna promoción?', 'general')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.matchedCategories[0]).toBe('promociones')
    expect(result.data.entries.map((e) => e.title)).toEqual(['Combo'])
  })

  it('orders by created_at ascending — oldest entries first', async () => {
    // Explicit timestamps: rows inserted in one statement share defaultNow(),
    // which would make the assertion depend on tie-breaking that does not exist.
    await seedEntries([
      {
        businessId: businessAId,
        title: 'Nueva',
        category: 'promociones',
        content: 'c',
        createdAt: new Date('2026-03-01T10:00:00Z'),
      },
      {
        businessId: businessAId,
        title: 'Vieja',
        category: 'promociones',
        content: 'a',
        createdAt: new Date('2026-01-01T10:00:00Z'),
      },
      {
        businessId: businessAId,
        title: 'Intermedia',
        category: 'promociones',
        content: 'b',
        createdAt: new Date('2026-02-01T10:00:00Z'),
      },
    ])

    const result = await searchByCategory(businessAId, 'tienen descuento', 'general')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.entries.map((e) => e.title)).toEqual(['Vieja', 'Intermedia', 'Nueva'])
  })

  it('excludes inactive entries', async () => {
    await seedEntries([
      { businessId: businessAId, title: 'Vigente', category: 'promociones', content: '2x1' },
      {
        businessId: businessAId,
        title: 'Vieja',
        category: 'promociones',
        content: '3x2',
        active: false,
      },
    ])

    const result = await searchByCategory(businessAId, 'tienen descuento', 'general')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.entries.map((e) => e.title)).toEqual(['Vigente'])
  })

  it('caps the detected category at the limit, keeping the oldest', async () => {
    // The newest three are unreachable by design once a category crosses the
    // cap — the admin panel warns the operator about exactly this.
    await seedEntries(
      Array.from({ length: 8 }, (_, i) => ({
        businessId: businessAId,
        title: `Promo ${i}`,
        category: 'promociones' as const,
        content: `oferta ${i}`,
        createdAt: new Date(Date.UTC(2026, 0, i + 1, 10)),
      })),
    )

    const result = await searchByCategory(businessAId, 'tienen descuento', 'general')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.entries).toHaveLength(5)
    expect(result.data.entries.map((e) => e.title)).toEqual([
      'Promo 0',
      'Promo 1',
      'Promo 2',
      'Promo 3',
      'Promo 4',
    ])
  })

  it("includes send_mode='always' entries even when their category was not detected", async () => {
    await seedEntries([
      {
        businessId: businessAId,
        title: 'Historia',
        category: 'informacion_general',
        content: 'Abrimos en 2015',
      },
      {
        businessId: businessAId,
        title: 'Formas de pago',
        category: 'politicas',
        content: 'Yape y Plin',
        sendMode: 'always',
      },
    ])

    const result = await searchByCategory(businessAId, '¿quién es la propietaria?', 'general')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.entries.map((e) => e.title).sort()).toEqual(['Formas de pago', 'Historia'])
  })

  it('includes a trigger_based entry only when its keywords hit the message', async () => {
    await seedEntries([
      {
        businessId: businessAId,
        title: 'Estacionamiento',
        category: 'informacion_general',
        content: 'Hay cochera en el sótano',
        sendMode: 'trigger_based',
        triggerKeywords: ['estacionamiento', 'cochera'],
      },
    ])

    const hit = await searchByCategory(businessAId, '¿tienen estacionamiento?', 'general')
    expect(hit.ok).toBe(true)
    if (hit.ok) expect(hit.data.entries.map((e) => e.title)).toEqual(['Estacionamiento'])

    // "quién es la propietaria" routes to `informacion_general`, but a
    // trigger_based entry must stay out until one of its own keywords appears.
    const miss = await searchByCategory(businessAId, '¿quién es la propietaria?', 'general')
    expect(miss.ok).toBe(true)
    if (miss.ok) expect(miss.data.entries).toEqual([])
  })

  it('falls back to the oldest entries when no category is detected', async () => {
    await seedEntries([
      {
        businessId: businessAId,
        title: 'Vieja',
        category: 'promociones',
        content: 'a',
        createdAt: new Date('2026-01-01T10:00:00Z'),
      },
      {
        businessId: businessAId,
        title: 'Nueva',
        category: 'informacion_general',
        content: 'b',
        createdAt: new Date('2026-02-01T10:00:00Z'),
      },
    ])

    const result = await searchByCategory(businessAId, 'hola buenas tardes', 'general')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.data.matchedCategories).toEqual([])
    expect(result.data.entries.map((e) => e.title)).toEqual(['Vieja', 'Nueva'])
  })

  it('never returns entries belonging to another business', async () => {
    await seedEntries([
      { businessId: businessAId, title: 'Promo A', category: 'promociones', content: '2x1' },
      { businessId: businessBId, title: 'Promo B', category: 'promociones', content: '3x2' },
      {
        businessId: businessBId,
        title: 'Siempre B',
        category: 'politicas',
        content: 'B policy',
        sendMode: 'always',
      },
    ])

    const resultA = await searchByCategory(businessAId, 'tienen descuento', 'general')
    expect(resultA.ok).toBe(true)
    if (!resultA.ok) return
    expect(resultA.data.entries.map((e) => e.title)).toEqual(['Promo A'])
    for (const entry of resultA.data.entries) {
      expect(entry.businessId).toBe(businessAId)
    }

    const resultB = await searchByCategory(businessBId, 'tienen descuento', 'general')
    expect(resultB.ok).toBe(true)
    if (!resultB.ok) return
    expect(resultB.data.entries.map((e) => e.title).sort()).toEqual(['Promo B', 'Siempre B'])
    for (const entry of resultB.data.entries) {
      expect(entry.businessId).toBe(businessBId)
    }
  })

  it('returns an empty list for a business with no entries', async () => {
    const result = await searchByCategory(businessAId, 'tienen descuento', 'general')
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
