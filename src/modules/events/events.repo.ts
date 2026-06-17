import { db, type Executor } from '@/db/client.js'
import { events, type Event, type NewEvent } from '@/db/schema/index.js'
import { and, desc, eq } from 'drizzle-orm'

export async function create(data: NewEvent, exec: Executor = db): Promise<Event> {
  const [row] = await exec.insert(events).values(data).returning()
  if (!row) throw new Error('insert events returned no row')
  return row
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
