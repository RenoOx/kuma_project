import { db } from '@/db/client.js'
import { googleCredentials } from '@/db/schema/index.js'
import * as googleCredentialsRepo from '@/modules/google/googleCredentials.repo.js'
import * as googleCredentialsService from '@/modules/google/googleCredentials.service.js'
import { NotConnectedError } from '@/shared/errors.js'
import { eq } from 'drizzle-orm'
import { afterAll, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeDb,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'

// Hoist the mock so we never make real network calls to Google during tests.
const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }))

vi.mock('@/modules/google/google.client.js', () => ({
  refreshAccessToken: mockRefresh,
  // The credentials service only uses refreshAccessToken from this module.
  // The other exports stay undefined; if anything else imports them via this
  // mocked path during tests, the import will surface clearly instead of
  // silently hitting the real client.
}))

describe('googleCredentialsService.getValidAccessToken', () => {
  let seed: TwoBusinessesSeed

  beforeEach(async () => {
    await resetDb()
    seed = await seedTwoBusinesses()
    mockRefresh.mockReset()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('returns NotConnectedError when the business has no google credentials', async () => {
    const result = await googleCredentialsService.getValidAccessToken(seed.businessA.id)
    assert(!result.ok)
    expect(result.error).toBeInstanceOf(NotConnectedError)
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('returns the current access_token when it is still safely in the future', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000) // 1 hour ahead
    await googleCredentialsRepo.upsert({
      businessId: seed.businessA.id,
      accessToken: 'access-still-valid',
      refreshToken: 'refresh-1',
      tokenExpiresAt: expiresAt,
      calendarId: 'primary',
      connectedEmail: 'owner@example.com',
    })

    const result = await googleCredentialsService.getValidAccessToken(seed.businessA.id)
    assert(result.ok)
    expect(result.data.accessToken).toBe('access-still-valid')
    expect(result.data.calendarId).toBe('primary')
    expect(mockRefresh).not.toHaveBeenCalled()
  })

  it('refreshes when the token is about to expire and persists the new one', async () => {
    // ~30 seconds in the future — under our 2-minute refresh threshold.
    const oldExpiresAt = new Date(Date.now() + 30 * 1000)
    await googleCredentialsRepo.upsert({
      businessId: seed.businessA.id,
      accessToken: 'access-stale',
      refreshToken: 'refresh-stale',
      tokenExpiresAt: oldExpiresAt,
      calendarId: 'primary',
      connectedEmail: 'owner@example.com',
    })

    const newExpiresAt = new Date(Date.now() + 60 * 60 * 1000)
    mockRefresh.mockResolvedValueOnce({
      accessToken: 'access-fresh',
      expiryDate: newExpiresAt,
    })

    const result = await googleCredentialsService.getValidAccessToken(seed.businessA.id)
    assert(result.ok)
    expect(result.data.accessToken).toBe('access-fresh')
    expect(mockRefresh).toHaveBeenCalledTimes(1)
    expect(mockRefresh).toHaveBeenCalledWith('refresh-stale')

    const [row] = await db
      .select()
      .from(googleCredentials)
      .where(eq(googleCredentials.businessId, seed.businessA.id))
    expect(row?.accessToken).toBe('access-fresh')
    // PG truncates to ms in `timestamp with time zone`, so allow a tiny delta.
    expect(Math.abs((row?.tokenExpiresAt?.getTime() ?? 0) - newExpiresAt.getTime())).toBeLessThan(2)
  })
})
