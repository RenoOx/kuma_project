import { db, type Executor } from '@/db/client.js'
import { messages, type Message, type NewMessage } from '@/db/schema/index.js'
import { and, asc, count, desc, eq, gte, lt } from 'drizzle-orm'

const DEFAULT_LIMIT = 50

export async function findByConversation(
  businessId: string,
  conversationId: string,
  limit: number = DEFAULT_LIMIT,
  exec: Executor = db,
): Promise<Message[]> {
  return await exec
    .select()
    .from(messages)
    .where(
      and(eq(messages.businessId, businessId), eq(messages.conversationId, conversationId)),
    )
    .orderBy(asc(messages.createdAt))
    .limit(limit)
}

// Fetches the LAST `limit` messages of the conversation, then reverses to ASC
// chronological order. The DESC + LIMIT + JS reverse pattern lets the database
// use the (conversation_id, created_at) index efficiently without scanning
// the whole conversation.
export async function findRecentByConversation(
  businessId: string,
  conversationId: string,
  limit: number,
  exec: Executor = db,
): Promise<Message[]> {
  const rows = await exec
    .select()
    .from(messages)
    .where(
      and(eq(messages.businessId, businessId), eq(messages.conversationId, conversationId)),
    )
    .orderBy(desc(messages.createdAt))
    .limit(limit)
  return rows.reverse()
}

export async function create(data: NewMessage, exec: Executor = db): Promise<Message> {
  const [row] = await exec.insert(messages).values(data).returning()
  if (!row) throw new Error('insert messages returned no row')
  return row
}

export async function countByConversation(
  businessId: string,
  conversationId: string,
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec
    .select({ value: count() })
    .from(messages)
    .where(
      and(eq(messages.businessId, businessId), eq(messages.conversationId, conversationId)),
    )
  return row?.value ?? 0
}

// Counts user-role messages in [since, until) for a business. Used by the
// owner's daily-summary tool.
export async function countUserMessagesInRange(
  businessId: string,
  since: Date,
  until: Date,
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec
    .select({ value: count() })
    .from(messages)
    .where(
      and(
        eq(messages.businessId, businessId),
        eq(messages.role, 'user'),
        gte(messages.createdAt, since),
        lt(messages.createdAt, until),
      ),
    )
  return row?.value ?? 0
}
