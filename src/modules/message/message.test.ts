import { db } from '@/db/client.js'
import { messages, type Conversation, type Customer } from '@/db/schema/index.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import * as messageRepo from '@/modules/message/message.repo.js'
import * as messageService from '@/modules/message/message.service.js'
import { count } from 'drizzle-orm'
import { afterAll, assert, beforeEach, describe, expect, it } from 'vitest'
import {
  closeDb,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'

describe('message module', () => {
  let seed: TwoBusinessesSeed
  let customerA: Customer
  let conversationA: Conversation

  beforeEach(async () => {
    await resetDb()
    seed = await seedTwoBusinesses()
    customerA = await customerRepo.create({
      businessId: seed.businessA.id,
      phone: '+51900000501',
      name: 'A-Cliente',
    })
    conversationA = await conversationRepo.create({
      businessId: seed.businessA.id,
      customerId: customerA.id,
    })
  })

  afterAll(async () => {
    await closeDb()
  })

  it('append inserts the message and updates conversation.lastMessageAt', async () => {
    const before = await conversationRepo.findById(seed.businessA.id, conversationA.id)
    expect(before?.lastMessageAt).toBeNull()

    const result = await messageService.append({
      businessId: seed.businessA.id,
      conversationId: conversationA.id,
      role: 'user',
      content: 'Hola',
    })
    assert(result.ok)

    const after = await conversationRepo.findById(seed.businessA.id, conversationA.id)
    expect(after?.lastMessageAt).toBeInstanceOf(Date)
    expect(after?.lastMessageAt?.getTime()).toBe(result.data.createdAt.getTime())
  })

  it('append rolls back when conversation does not exist (no orphan message)', async () => {
    const result = await messageService.append({
      businessId: seed.businessA.id,
      conversationId: 'nonexistent_conversation_id',
      role: 'user',
      content: 'never persisted',
    })
    assert(!result.ok)

    const [row] = await db.select({ value: count() }).from(messages)
    expect(row?.value).toBe(0)
  })

  it('getRecentHistory respects the limit', async () => {
    for (let i = 0; i < 20; i++) {
      const r = await messageService.append({
        businessId: seed.businessA.id,
        conversationId: conversationA.id,
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg-${i}`,
      })
      assert(r.ok)
    }

    const result = await messageService.getRecentHistory(seed.businessA.id, conversationA.id, 5)
    assert(result.ok)
    expect(result.data).toHaveLength(5)
  })

  it('getRecentHistory returns the LAST N messages in ASC chronological order', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await messageService.append({
        businessId: seed.businessA.id,
        conversationId: conversationA.id,
        role: 'user',
        content: `msg-${i}`,
      })
      assert(r.ok)
      // Force timestamp separation; tests can otherwise insert several rows
      // in the same millisecond bucket and break order assertions.
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    const result = await messageService.getRecentHistory(seed.businessA.id, conversationA.id, 3)
    assert(result.ok)
    expect(result.data.map((m) => m.content)).toEqual(['msg-3', 'msg-4', 'msg-5'])

    for (let i = 1; i < result.data.length; i++) {
      const prev = result.data[i - 1]
      const cur = result.data[i]
      assert(prev !== undefined && cur !== undefined)
      expect(cur.createdAt.getTime()).toBeGreaterThanOrEqual(prev.createdAt.getTime())
    }
  })

  it('isolation: messages of businessA are not returned when querying with businessB', async () => {
    const r = await messageService.append({
      businessId: seed.businessA.id,
      conversationId: conversationA.id,
      role: 'user',
      content: 'A.user',
    })
    assert(r.ok)

    const fromB = await messageRepo.findByConversation(seed.businessB.id, conversationA.id)
    expect(fromB).toEqual([])
  })
})
