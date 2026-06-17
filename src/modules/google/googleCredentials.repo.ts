import { db, type Executor } from '@/db/client.js'
import {
  googleCredentials,
  type GoogleCredentials,
  type NewGoogleCredentials,
} from '@/db/schema/index.js'
import { eq } from 'drizzle-orm'

export async function findByBusiness(
  businessId: string,
  exec: Executor = db,
): Promise<GoogleCredentials | null> {
  const [row] = await exec
    .select()
    .from(googleCredentials)
    .where(eq(googleCredentials.businessId, businessId))
    .limit(1)
  return row ?? null
}

// Upsert by business_id: re-connecting an already-linked business replaces
// the tokens but keeps the row stable so any joined data survives.
export async function upsert(
  data: NewGoogleCredentials,
  exec: Executor = db,
): Promise<GoogleCredentials> {
  const [row] = await exec
    .insert(googleCredentials)
    .values(data)
    .onConflictDoUpdate({
      target: googleCredentials.businessId,
      set: {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        tokenExpiresAt: data.tokenExpiresAt,
        calendarId: data.calendarId ?? 'primary',
        connectedEmail: data.connectedEmail,
        updatedAt: new Date(),
      },
    })
    .returning()
  if (!row) throw new Error('upsert google_credentials returned no row')
  return row
}

export async function updateTokens(
  businessId: string,
  patch: { accessToken: string; tokenExpiresAt: Date },
  exec: Executor = db,
): Promise<GoogleCredentials> {
  const [row] = await exec
    .update(googleCredentials)
    .set({
      accessToken: patch.accessToken,
      tokenExpiresAt: patch.tokenExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(googleCredentials.businessId, businessId))
    .returning()
  if (!row) throw new Error(`google_credentials for business ${businessId} not found`)
  return row
}

export async function deleteByBusiness(
  businessId: string,
  exec: Executor = db,
): Promise<void> {
  await exec.delete(googleCredentials).where(eq(googleCredentials.businessId, businessId))
}
