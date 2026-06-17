import { db } from '@/db/client.js'
import { businesses } from '@/db/schema/index.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { notifyOwner } from '@/modules/whatsapp/ownerNotifier.js'
import { eq } from 'drizzle-orm'
import { afterAll, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeDb,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'

interface FakeClient {
  sendMessage: ReturnType<typeof vi.fn>
}

function makeFakeClient(): FakeClient {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) }
}

describe('notifyOwner', () => {
  let seed: TwoBusinessesSeed

  beforeEach(async () => {
    await resetDb()
    seed = await seedTwoBusinesses()
    clientRegistry._resetRegistryForTests()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('returns ok without calling sendMessage when business has no ownerWhatsappNumber', async () => {
    const fake = makeFakeClient()
    clientRegistry.registerClient(seed.businessA.id, fake as unknown as Parameters<typeof clientRegistry.registerClient>[1])

    const result = await notifyOwner(seed.businessA.id, 'hola dueño')

    assert(result.ok)
    expect(fake.sendMessage).not.toHaveBeenCalled()
  })

  it('sends a message to the owner JID when ownerWhatsappNumber + client are configured', async () => {
    await db
      .update(businesses)
      .set({ ownerWhatsappNumber: '+51999000111', ownerName: 'Renzo' })
      .where(eq(businesses.id, seed.businessA.id))

    const fake = makeFakeClient()
    clientRegistry.registerClient(seed.businessA.id, fake as unknown as Parameters<typeof clientRegistry.registerClient>[1])

    const result = await notifyOwner(seed.businessA.id, '🔔 algo pasó')

    assert(result.ok)
    expect(fake.sendMessage).toHaveBeenCalledTimes(1)
    expect(fake.sendMessage).toHaveBeenCalledWith('51999000111@s.whatsapp.net', '🔔 algo pasó')
  })

  it('returns err when the underlying sendMessage throws', async () => {
    await db
      .update(businesses)
      .set({ ownerWhatsappNumber: '+51999000111' })
      .where(eq(businesses.id, seed.businessA.id))

    const fake: FakeClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error('connection closed')),
    }
    clientRegistry.registerClient(seed.businessA.id, fake as unknown as Parameters<typeof clientRegistry.registerClient>[1])

    const result = await notifyOwner(seed.businessA.id, 'no llega')

    assert(!result.ok)
    expect(result.error.code).toBe('notify_owner_failed')
    expect(fake.sendMessage).toHaveBeenCalledTimes(1)
  })
})
