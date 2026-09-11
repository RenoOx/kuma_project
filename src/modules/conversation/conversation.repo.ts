import { and, count, desc, eq, gte, isNull, notInArray, or, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db/client.js'
import {
  type Conversation,
  type ConversationQualification,
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

// Qualifications a fixed rule owns. Once a conversation carries one of these,
// the LLM's read of the room does not get to overwrite it: a booked appointment
// is a fact, an escalation is a fact, and a human holding the thread is a fact,
// while classify_interest is an opinion formed from the last few messages.
// PANEL_SPEC US-02 AC5.
const LLM_PINNED_QUALIFICATIONS: ConversationQualification[] = [
  'appointment',
  'needs_info',
  'human_takeover',
]

/** Unconditional write. For the fixed rules, which outrank the model. */
export async function updateQualification(
  businessId: string,
  id: string,
  qualification: ConversationQualification,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(conversations)
    .set({ qualification, updatedAt: new Date() })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, id)))
}

/**
 * The model's write. Skips rows a fixed rule already pinned.
 *
 * Expressed as one conditional UPDATE rather than a read-then-write so there is
 * no window between the two: book_appointment and classify_interest can land in
 * the same LLM turn, in either order, and a check-then-write would let the
 * opinion clobber the fact depending on which finished first.
 *
 * Returns whether the row actually moved, for the log line.
 */
export async function updateQualificationIfNotPinned(
  businessId: string,
  id: string,
  qualification: ConversationQualification,
  exec: Executor = db,
): Promise<boolean> {
  const updated = await exec
    .update(conversations)
    .set({ qualification, updatedAt: new Date() })
    .where(
      and(
        eq(conversations.businessId, businessId),
        eq(conversations.id, id),
        notInArray(conversations.qualification, LLM_PINNED_QUALIFICATIONS),
        // Pinned by origin: the owner chose this label by hand and the model
        // does not get a vote until they release it.
        isNull(conversations.qualificationLockedAt),
      ),
    )
    .returning({ id: conversations.id })
  return updated.length > 0
}

/**
 * The owner's write, from the panel.
 *
 * Sets the label and the lock in the same statement: a two-step write would
 * leave a window where classify_interest sees an unlocked row carrying a label
 * a person just chose, which is precisely the race the lock exists to close.
 */
export async function lockQualification(
  businessId: string,
  id: string,
  qualification: ConversationQualification,
  exec: Executor = db,
): Promise<boolean> {
  const now = new Date()
  const updated = await exec
    .update(conversations)
    .set({ qualification, qualificationLockedAt: now, updatedAt: now })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, id)))
    .returning({ id: conversations.id })
  return updated.length > 0
}

/**
 * Releases the owner's lock, handing the label back to Emma and the worker.
 *
 * Called where a new fact outranks the old decision: the customer came back
 * from the dead, or the owner handed the thread over deliberately.
 */
export async function clearQualificationLock(
  businessId: string,
  id: string,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(conversations)
    .set({ qualificationLockedAt: null, updatedAt: new Date() })
    .where(and(eq(conversations.businessId, businessId), eq(conversations.id, id)))
}

/**
 * Starts or clears the human-takeover clock.
 *
 * Written together with the qualification because the two are one fact: a
 * thread is held by a human, or it is not. Splitting them across two updates
 * is how you end up with a takeover timestamp on a conversation Emma is
 * answering, or the reverse — a thread nobody can get back because the
 * auto-return worker sees no clock to expire.
 */
export async function setHumanTakeover(
  businessId: string,
  id: string,
  takeoverAt: Date | null,
  qualification: ConversationQualification,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(conversations)
    .set({ humanTakeoverAt: takeoverAt, qualification, updatedAt: new Date() })
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
