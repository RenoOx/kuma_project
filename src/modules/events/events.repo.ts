import { and, desc, eq, gte } from 'drizzle-orm'
import { db, type Executor } from '@/db/client.js'
import { type Event, events, type NewEvent } from '@/db/schema/index.js'

export async function create(data: NewEvent, exec: Executor = db): Promise<Event> {
  const [row] = await exec.insert(events).values(data).returning()
  if (!row) throw new Error('insert events returned no row')
  return row
}

// True when an event of `type` was recorded for this conversation at or after
// `since`. Used by the deposit gate to answer "did a photo arrive recently?".
export async function existsSince(
  businessId: string,
  conversationId: string,
  type: string,
  since: Date,
  exec: Executor = db,
): Promise<boolean> {
  const [row] = await exec
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.businessId, businessId),
        eq(events.conversationId, conversationId),
        eq(events.type, type),
        gte(events.createdAt, since),
      ),
    )
    .limit(1)
  return row !== undefined
}

// Returns the `reason` field from the latest 'escalation' event of a
// conversation, or null if no such event was ever recorded.
export async function findLatestEscalationReason(
  businessId: string,
  conversationId: string,
  exec: Executor = db,
): Promise<string | null> {
  const [row] = await exec
    .select({ payload: events.payload })
    .from(events)
    .where(
      and(
        eq(events.businessId, businessId),
        eq(events.conversationId, conversationId),
        eq(events.type, 'escalation'),
      ),
    )
    .orderBy(desc(events.createdAt))
    .limit(1)
  if (!row) return null
  const payload = row.payload as { reason?: unknown } | null
  return typeof payload?.reason === 'string' ? payload.reason : null
}
