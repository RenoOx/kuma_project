import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../src/db/client.js'
import {
  appointments,
  businesses,
  conversations,
  customers,
  events,
  knowledgeBase,
  messages,
} from '../../src/db/schema/index.js'
import { closeDb, resetDb, seedTwoBusinesses } from '../helpers/db.js'

describe('multi-tenant isolation', () => {
  beforeEach(async () => {
    await resetDb()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('isolates customers by businessId', async () => {
    const { businessA, businessB } = await seedTwoBusinesses()

    await db.insert(customers).values({
      businessId: businessA.id,
      phone: '+51911111111',
      name: 'Cliente A',
    })

    const aRows = await db.select().from(customers).where(eq(customers.businessId, businessA.id))
    const bRows = await db.select().from(customers).where(eq(customers.businessId, businessB.id))

    expect(aRows).toHaveLength(1)
    expect(aRows[0]?.name).toBe('Cliente A')
    expect(bRows).toHaveLength(0)
  })

  it('isolates knowledge_base entries by businessId', async () => {
    const { businessA, businessB } = await seedTwoBusinesses()

    await db.insert(knowledgeBase).values([
      { businessId: businessA.id, category: 'services', content: 'Corte, barba' },
      { businessId: businessA.id, category: 'pricing', content: 'S/30 corte' },
    ])

    const aRows = await db
      .select()
      .from(knowledgeBase)
      .where(eq(knowledgeBase.businessId, businessA.id))
    const bRows = await db
      .select()
      .from(knowledgeBase)
      .where(eq(knowledgeBase.businessId, businessB.id))

    expect(aRows).toHaveLength(2)
    expect(bRows).toHaveLength(0)
  })

  it('isolates conversation messages by businessId', async () => {
    const { businessA, businessB } = await seedTwoBusinesses()

    const [custA] = await db
      .insert(customers)
      .values({ businessId: businessA.id, phone: '+51911111111', name: 'Cliente A' })
      .returning()
    const [custB] = await db
      .insert(customers)
      .values({ businessId: businessB.id, phone: '+51922222222', name: 'Cliente B' })
      .returning()
    if (!custA || !custB) throw new Error('seed customers failed')

    const [convA] = await db
      .insert(conversations)
      .values({ businessId: businessA.id, customerId: custA.id })
      .returning()
    const [convB] = await db
      .insert(conversations)
      .values({ businessId: businessB.id, customerId: custB.id })
      .returning()
    if (!convA || !convB) throw new Error('seed conversations failed')

    await db.insert(messages).values([
      { conversationId: convA.id, businessId: businessA.id, role: 'user', content: 'A.user.1' },
      {
        conversationId: convA.id,
        businessId: businessA.id,
        role: 'assistant',
        content: 'A.asst.1',
      },
      { conversationId: convA.id, businessId: businessA.id, role: 'user', content: 'A.user.2' },
      { conversationId: convB.id, businessId: businessB.id, role: 'user', content: 'B.user.1' },
    ])

    const aMessages = await db
      .select({ content: messages.content })
      .from(messages)
      .where(eq(messages.businessId, businessA.id))
      .orderBy(asc(messages.createdAt))

    expect(aMessages).toHaveLength(3)
    expect(aMessages.map((m) => m.content)).toEqual(['A.user.1', 'A.asst.1', 'A.user.2'])
    expect(aMessages.every((m) => !m.content.startsWith('B.'))).toBe(true)
  })

  it('isolates appointments by businessId', async () => {
    const { businessA, businessB } = await seedTwoBusinesses()

    const [custA] = await db
      .insert(customers)
      .values({ businessId: businessA.id, phone: '+51911111111' })
      .returning()
    if (!custA) throw new Error('seed customer failed')

    await db.insert(appointments).values({
      businessId: businessA.id,
      customerId: custA.id,
      service: 'corte de cabello',
      scheduledAt: new Date('2026-07-01T15:00:00-05:00'),
    })

    const aRows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, businessA.id))
    const bRows = await db
      .select()
      .from(appointments)
      .where(eq(appointments.businessId, businessB.id))

    expect(aRows).toHaveLength(1)
    expect(aRows[0]?.service).toBe('corte de cabello')
    expect(bRows).toHaveLength(0)
  })

  it('cascade-deletes all businessA data and leaves businessB intact', async () => {
    const { businessA, businessB } = await seedTwoBusinesses()

    // Seed full graph for A
    const [custA] = await db
      .insert(customers)
      .values({ businessId: businessA.id, phone: '+51911111111' })
      .returning()
    const [custB] = await db
      .insert(customers)
      .values({ businessId: businessB.id, phone: '+51922222222' })
      .returning()
    if (!custA || !custB) throw new Error('seed customers failed')

    await db.insert(knowledgeBase).values([
      { businessId: businessA.id, category: 'services', content: 'A services' },
      { businessId: businessB.id, category: 'services', content: 'B services' },
    ])

    const [convA] = await db
      .insert(conversations)
      .values({ businessId: businessA.id, customerId: custA.id })
      .returning()
    const [convB] = await db
      .insert(conversations)
      .values({ businessId: businessB.id, customerId: custB.id })
      .returning()
    if (!convA || !convB) throw new Error('seed conversations failed')

    await db.insert(messages).values([
      { conversationId: convA.id, businessId: businessA.id, role: 'user', content: 'A msg' },
      { conversationId: convB.id, businessId: businessB.id, role: 'user', content: 'B msg' },
    ])

    await db.insert(appointments).values([
      {
        businessId: businessA.id,
        customerId: custA.id,
        service: 'corte',
        scheduledAt: new Date('2026-07-01T15:00:00-05:00'),
      },
      {
        businessId: businessB.id,
        customerId: custB.id,
        service: 'corte',
        scheduledAt: new Date('2026-07-01T16:00:00-05:00'),
      },
    ])

    await db.insert(events).values([
      { businessId: businessA.id, conversationId: convA.id, type: 'tool_call' },
      { businessId: businessB.id, conversationId: convB.id, type: 'tool_call' },
    ])

    // Pre-flight sanity
    const beforeA = await db.select().from(customers).where(eq(customers.businessId, businessA.id))
    const beforeB = await db.select().from(customers).where(eq(customers.businessId, businessB.id))
    expect(beforeA).toHaveLength(1)
    expect(beforeB).toHaveLength(1)

    // Delete businessA — cascade should sweep everything tagged with businessA.id
    await db.delete(businesses).where(eq(businesses.id, businessA.id))

    // All A data gone
    expect(await db.select().from(customers).where(eq(customers.businessId, businessA.id))).toEqual(
      [],
    )
    expect(
      await db.select().from(knowledgeBase).where(eq(knowledgeBase.businessId, businessA.id)),
    ).toEqual([])
    expect(
      await db.select().from(conversations).where(eq(conversations.businessId, businessA.id)),
    ).toEqual([])
    expect(await db.select().from(messages).where(eq(messages.businessId, businessA.id))).toEqual(
      [],
    )
    expect(
      await db.select().from(appointments).where(eq(appointments.businessId, businessA.id)),
    ).toEqual([])
    expect(await db.select().from(events).where(eq(events.businessId, businessA.id))).toEqual([])

    // All B data intact
    expect(
      await db.select().from(businesses).where(eq(businesses.id, businessB.id)),
    ).toHaveLength(1)
    expect(
      await db.select().from(customers).where(eq(customers.businessId, businessB.id)),
    ).toHaveLength(1)
    expect(
      await db.select().from(knowledgeBase).where(eq(knowledgeBase.businessId, businessB.id)),
    ).toHaveLength(1)
    expect(
      await db.select().from(conversations).where(eq(conversations.businessId, businessB.id)),
    ).toHaveLength(1)
    expect(
      await db.select().from(messages).where(eq(messages.businessId, businessB.id)),
    ).toHaveLength(1)
    expect(
      await db.select().from(appointments).where(eq(appointments.businessId, businessB.id)),
    ).toHaveLength(1)
    expect(await db.select().from(events).where(eq(events.businessId, businessB.id))).toHaveLength(
      1,
    )
  })
})
