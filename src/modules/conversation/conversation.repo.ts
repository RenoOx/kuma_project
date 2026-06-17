import { db, type Executor } from '@/db/client.js'
import {
  conversations,
  type Conversation,
  type ConversationStatus,
  type NewConversation,
} from '@/db/schema/index.js'
import { and, count, eq, gte } from 'drizzle-orm'

export async function findOpenByCustomer(
  businessId: string,
  customerId: string,
  exec: Executor = db,
): Promise<Conversation | null> {
  const [row] = await exec
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, businessId),
        eq(conversations.customerId, customerId),
        eq(conversations.status, 'open'),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function findById(
  businessId: string,
  id: string,
  exec: Executor = db,
): Promise<Conversation | null> {
  const [row] = await exec
    .select()
    .from(conversations)
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, id)))
    .limit(1)
  return row ?? null
}

export async function findOwnerThread(
  businessId: string,
  exec: Executor = db,
): Promise<Conversation | null> {
  const [row] = await exec
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.businessId, businessId), eq(conversations.type, 'owner_thread')),
    )
    .limit(1)
  return row ?? null
}

export async function create(
  data: NewConversation,
  exec: Executor = db,
): Promise<Conversation> {
  const [row] = await exec.insert(conversations).values(data).returning()
  if (!row) throw new Error('insert conversations returned no row')
  return row
}

// Count escalated customer conversations updated since `since`. Used by the
// owner daily summary to surface pending escalations.
export async function countRecentEscalatedCustomerConversations(
  businessId: string,
  since: Date,
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec
    .select({ value: count() })
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, businessId),
        eq(conversations.type, 'customer'),
        eq(conversations.status, 'escalated'),
        gte(conversations.updatedAt, since),
      ),
    )
  return row?.value ?? 0
}

export async function updateStatus(
  businessId: string,
  id: string,
  status: ConversationStatus,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(conversations)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, id)))
}

export async function updateLastMessageAt(
  businessId: string,
  id: string,
  at: Date,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(conversations)
    .set({ lastMessageAt: at, updatedAt: at })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, id)))
}
