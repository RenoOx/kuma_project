import { db } from '@/db/client.js'
import { conversations, type Customer } from '@/db/schema/index.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import { NotFoundError } from '@/shared/errors.js'
import { eq } from 'drizzle-orm'
import { afterAll, assert, beforeEach, describe, expect, it } from 'vitest'
import {
  closeDb,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'

describe('conversation module', () => {
  let seed: TwoBusinessesSeed
  let customerA: Customer
  let customerB: Customer

  beforeEach(async () => {
    await resetDb()
    seed = await seedTwoBusinesses()
    customerA = await customerRepo.create({
      businessId: seed.businessA.id,
      phone: '+51900000401',
      name: 'A-Cliente',
    })
    customerB = await customerRepo.create({
      businessId: seed.businessB.id,
      phone: '+51900000402',
      name: 'B-Cliente',
    })
  })

  afterAll(async () => {
    await closeDb()
  })

  it('getOrCreateOpen creates a fresh open conversation when none exists', async () => {
    const result = await conversationService.getOrCreateOpen(seed.businessA.id, customerA.id)
    assert(result.ok)
    expect(result.data.status).toBe('open')
    expect(result.data.businessId).toBe(seed.businessA.id)
    expect(result.data.customerId).toBe(customerA.id)

    const all = await db.select().from(conversations)
    expect(all).toHaveLength(1)
  })

  it('getOrCreateOpen reuses an existing open conversation', async () => {
    const first = await conversationService.getOrCreateOpen(seed.businessA.id, customerA.id)
    const second = await conversationService.getOrCreateOpen(seed.businessA.id, customerA.id)
    assert(first.ok)
    assert(second.ok)
    expect(second.data.id).toBe(first.data.id)

    const all = await db.select().from(conversations)
    expect(all).toHaveLength(1)
  })

  it('getOrCreateOpen creates a new conversation when the previous one is closed', async () => {
    const first = await conversationService.getOrCreateOpen(seed.businessA.id, customerA.id)
    assert(first.ok)
    const closeResult = await conversationService.close(seed.businessA.id, first.data.id)
    assert(closeResult.ok)

    const second = await conversationService.getOrCreateOpen(seed.businessA.id, customerA.id)
    assert(second.ok)
    expect(second.data.id).not.toBe(first.data.id)
    expect(second.data.status).toBe('open')

    const all = await db.select().from(conversations)
    expect(all).toHaveLength(2)
  })

  it('close sets status to closed', async () => {
    const created = await conversationService.getOrCreateOpen(seed.businessA.id, customerA.id)
    assert(created.ok)
    const result = await conversationService.close(seed.businessA.id, created.data.id)
    assert(result.ok)

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, created.data.id))
    expect(row?.status).toBe('closed')
  })

  it('escalate sets status to escalated', async () => {
    const created = await conversationService.getOrCreateOpen(seed.businessA.id, customerA.id)
    assert(created.ok)
    const result = await conversationService.escalate(seed.businessA.id, created.data.id)
    assert(result.ok)

    const [row] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, created.data.id))
    expect(row?.status).toBe('escalated')
  })

  it('close returns NotFoundError when called from a different business', async () => {
    const createdInA = await conversationService.getOrCreateOpen(seed.businessA.id, customerA.id)
    assert(createdInA.ok)

    const result = await conversationService.close(seed.businessB.id, createdInA.data.id)
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(NotFoundError)
  })

  it('isolation: a conversation of businessA is not visible querying businessB', async () => {
    const inA = await conversationService.getOrCreateOpen(seed.businessA.id, customerA.id)
    assert(inA.ok)

    // B sees nothing under A's id
    const fromB = await conversationRepo.findById(seed.businessB.id, inA.data.id)
    expect(fromB).toBeNull()

    // B's customerId lookup also has no open conversation
    const fromBByCustomer = await conversationRepo.findOpenByCustomer(
      seed.businessB.id,
      customerB.id,
    )
    expect(fromBByCustomer).toBeNull()
  })
})
