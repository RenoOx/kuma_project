import { and, count, desc, eq, gte, isNull, or, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db/client.js'
import {
  type Conversation,
  type ConversationStatus,
  conversations,
  customers,
  type NewConversation,
} from '@/db/schema/index.js'

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

// Most recent escalated conversation of a customer that was still active at or
// after `since`. Activity is the last message, falling back to the creation
// time for a thread that never got one.
//
// Recency is measured by activity rather than by creation on purpose: a thread
// opened last week and escalated this morning is exactly the one the customer
// is still in, and keying on created_at would skip it.
export async function findRecentEscalatedByCustomer(
  businessId: string,
  customerId: string,
  since: Date,
  exec: Executor = db,
): Promise<Conversation | null> {
  // The comparison is spelled out with typed operators rather than a raw
  // COALESCE: values interpolated into a raw sql`` fragment skip the column's
  // driver encoder, so the Date would reach postgres-js unserialized. Ordering
  // takes no parameters, so COALESCE is safe there.
  const lastActivity = sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt})`
  const [row] = await exec
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, businessId),
        eq(conversations.customerId, customerId),
        eq(conversations.status, 'escalated'),
        or(
          gte(conversations.lastMessageAt, since),
          and(isNull(conversations.lastMessageAt), gte(conversations.createdAt, since)),
        ),
      ),
    )
    .orderBy(desc(lastActivity))
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
    .where(and(eq(conversations.businessId, businessId), eq(conversations.type, 'owner_thread')))
    .limit(1)
  return row ?? null
}

export async function create(data: NewConversation, exec: Executor = db): Promise<Conversation> {
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

export interface EscalatedConversationSummary {
  conversationId: string
  customerName: string | null
  customerPhone: string
  updatedAt: Date
}

// Lists escalated customer conversations updated since `since`, joined to
// their customer row. Used to render the "pending escalations" block of the
// daily report.
export async function listRecentEscalatedCustomerConversations(
  businessId: string,
  since: Date,
  limit: number,
  exec: Executor = db,
): Promise<EscalatedConversationSummary[]> {
  return await exec
    .select({
      conversationId: conversations.id,
      customerName: customers.name,
      customerPhone: customers.phone,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .innerJoin(customers, eq(customers.id, conversations.customerId))
    .where(
      and(
        eq(conversations.businessId, businessId),
        eq(conversations.type, 'customer'),
        eq(conversations.status, 'escalated'),
        gte(conversations.updatedAt, since),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(limit)
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

// The state machine's write. Kept beside updateStatus because they are the same
// shape, but they are different columns with different owners: status is set
// from several places, state only ever from conversation.service.applyTrigger.
export async function updateState(
  businessId: string,
  id: string,
  state: string,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(conversations)
    .set({ state, updatedAt: new Date() })
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
