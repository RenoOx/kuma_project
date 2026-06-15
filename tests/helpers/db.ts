import { sql } from 'drizzle-orm'
import { env } from '../../src/config/env.js'
import { db, queryClient } from '../../src/db/client.js'
import { businesses } from '../../src/db/schema/index.js'

if (env.NODE_ENV === 'production') {
  throw new Error('refusing to load test DB helpers in production')
}

export async function resetDb(): Promise<void> {
  // Single TRUNCATE with CASCADE handles all FK chains in one statement.
  // Order in the list is irrelevant when CASCADE is used.
  await db.execute(sql`
    TRUNCATE TABLE
      "events",
      "messages",
      "appointments",
      "conversations",
      "knowledge_base",
      "customers",
      "businesses"
    RESTART IDENTITY CASCADE
  `)
}

export async function closeDb(): Promise<void> {
  await queryClient.end({ timeout: 1 }).catch(() => undefined)
}

export interface SeededBusiness {
  id: string
  whatsappNumber: string
  name: string
}

export interface TwoBusinessesSeed {
  businessA: SeededBusiness
  businessB: SeededBusiness
}

export async function seedTwoBusinesses(): Promise<TwoBusinessesSeed> {
  const [a, b] = await db
    .insert(businesses)
    .values([
      { name: 'Barbería A', whatsappNumber: '+51900000001' },
      { name: 'Barbería B', whatsappNumber: '+51900000002' },
    ])
    .returning({
      id: businesses.id,
      whatsappNumber: businesses.whatsappNumber,
      name: businesses.name,
    })

  if (!a || !b) {
    throw new Error('failed to seed two businesses')
  }

  return { businessA: a, businessB: b }
}
