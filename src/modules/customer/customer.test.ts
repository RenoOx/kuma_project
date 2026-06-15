import { db } from '@/db/client.js'
import { customers } from '@/db/schema/index.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import * as customerService from '@/modules/customer/customer.service.js'
import { NotFoundError } from '@/shared/errors.js'
import { afterAll, assert, beforeEach, describe, expect, it } from 'vitest'
import {
  closeDb,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'

describe('customer module', () => {
  let seed: TwoBusinessesSeed

  beforeEach(async () => {
    await resetDb()
    seed = await seedTwoBusinesses()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('getOrCreate creates a new customer when phone is unknown', async () => {
    const result = await customerService.getOrCreate(seed.businessA.id, '+51900000300', 'Juan')
    assert(result.ok)
    expect(result.data.phone).toBe('+51900000300')
    expect(result.data.name).toBe('Juan')
    expect(result.data.businessId).toBe(seed.businessA.id)
    expect(result.data.lastSeenAt).toBeInstanceOf(Date)

    const all = await db.select().from(customers)
    expect(all).toHaveLength(1)
  })

  it('getOrCreate returns existing customer and bumps lastSeenAt', async () => {
    const first = await customerService.getOrCreate(seed.businessA.id, '+51900000301', 'Ana')
    assert(first.ok)
    const firstSeen = first.data.lastSeenAt
    expect(firstSeen).toBeInstanceOf(Date)

    await new Promise((resolve) => setTimeout(resolve, 50))

    const second = await customerService.getOrCreate(seed.businessA.id, '+51900000301')
    assert(second.ok)
    expect(second.data.id).toBe(first.data.id)
    expect(second.data.lastSeenAt).toBeInstanceOf(Date)
    const secondMs = (second.data.lastSeenAt as Date).getTime()
    const firstMs = (firstSeen as Date).getTime()
    expect(secondMs).toBeGreaterThan(firstMs)

    const all = await db.select().from(customers)
    expect(all).toHaveLength(1)
  })

  it('getOrCreate scopes by businessId — same phone across tenants creates two customers', async () => {
    const inA = await customerService.getOrCreate(seed.businessA.id, '+51900000302', 'A-side')
    const inB = await customerService.getOrCreate(seed.businessB.id, '+51900000302', 'B-side')
    assert(inA.ok)
    assert(inB.ok)

    expect(inA.data.id).not.toBe(inB.data.id)
    expect(inA.data.businessId).toBe(seed.businessA.id)
    expect(inB.data.businessId).toBe(seed.businessB.id)

    const all = await db.select().from(customers)
    expect(all).toHaveLength(2)
  })

  it('getById returns NotFoundError for an unknown id', async () => {
    const result = await customerService.getById(seed.businessA.id, 'nonexistent_id')
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(NotFoundError)
    expect(result.error.code).toBe('not_found')
  })

  it('getById returns NotFoundError when id belongs to a different business', async () => {
    const aCustomer = await customerRepo.create({
      businessId: seed.businessA.id,
      phone: '+51900000303',
      name: 'A only',
    })

    const fromB = await customerService.getById(seed.businessB.id, aCustomer.id)
    assert(!fromB.ok)
    expect(fromB.error).toBeInstanceOf(NotFoundError)
  })
})
