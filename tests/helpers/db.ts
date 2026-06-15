import { sql } from 'drizzle-orm'
import { env } from '../../src/config/env.js'
import { db, queryClient } from '../../src/db/client.js'
import { businesses } from '../../src/db/schema/index.js'
import type { BusinessSettings } from '../../src/modules/business/business.settings.js'

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

// Standard test fixture: Monday–Saturday 09:00–19:00 with a lunch break
// 13:00–14:00, closed Sundays. Slot grid: 60 min. Services: corte (30 min)
// and barba (20 min). Most tests pile on top of this; the few that exercise
// the "no settings" path pass { withSettings: false }.
export const DEFAULT_TEST_SETTINGS: BusinessSettings = {
  operatingHours: {
    monday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
    tuesday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
    wednesday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
    thursday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
    friday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
    saturday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
    sunday: null,
  },
  slotDurationMinutes: 60,
  services: [
    { name: 'corte', durationMinutes: 30 },
    { name: 'barba', durationMinutes: 20 },
  ],
}

export interface SeedTwoBusinessesOptions {
  withSettings?: boolean
}

export async function seedTwoBusinesses(
  opts?: SeedTwoBusinessesOptions,
): Promise<TwoBusinessesSeed> {
  const withSettings = opts?.withSettings ?? true
  const settingsForA = withSettings ? DEFAULT_TEST_SETTINGS : {}
  const settingsForB = withSettings ? DEFAULT_TEST_SETTINGS : {}

  const [a, b] = await db
    .insert(businesses)
    .values([
      { name: 'Barbería A', whatsappNumber: '+51900000001', settings: settingsForA },
      { name: 'Barbería B', whatsappNumber: '+51900000002', settings: settingsForB },
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
