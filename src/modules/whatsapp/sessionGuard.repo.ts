import { eq } from 'drizzle-orm'
import { db, type Executor } from '@/db/client.js'
import {
  type NewWhatsappSessionGuard,
  type WhatsappSessionGuard,
  whatsappSessionGuard,
} from '@/db/schema/index.js'

export async function findByNumber(
  whatsappNumber: string,
  exec: Executor = db,
): Promise<WhatsappSessionGuard | null> {
  const [row] = await exec
    .select()
    .from(whatsappSessionGuard)
    .where(eq(whatsappSessionGuard.whatsappNumber, whatsappNumber))
    .limit(1)
  return row ?? null
}

// Upsert on the number so concurrent callers can't race two rows for the same
// phone — the UNIQUE constraint is the source of truth.
export async function upsert(
  data: NewWhatsappSessionGuard,
  exec: Executor = db,
): Promise<WhatsappSessionGuard> {
  const { whatsappNumber, ...rest } = data
  const [row] = await exec
    .insert(whatsappSessionGuard)
    .values(data)
    .onConflictDoUpdate({
      target: whatsappSessionGuard.whatsappNumber,
      set: { ...rest, updatedAt: new Date() },
    })
    .returning()
  if (!row) throw new Error(`upsert whatsapp_session_guard returned no row for ${whatsappNumber}`)
  return row
}
