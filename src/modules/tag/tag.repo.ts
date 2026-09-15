import { and, asc, eq, inArray } from 'drizzle-orm'
import { db, type Executor } from '@/db/client.js'
import { conversations, conversationTags, type NewTag, type Tag, tags } from '@/db/schema/index.js'

export async function findByBusiness(businessId: string, exec: Executor = db): Promise<Tag[]> {
  return await exec
    .select()
    .from(tags)
    .where(eq(tags.businessId, businessId))
    .orderBy(asc(tags.createdAt))
}

export async function countByBusiness(businessId: string, exec: Executor = db): Promise<number> {
  const rows = await exec.select({ id: tags.id }).from(tags).where(eq(tags.businessId, businessId))
  return rows.length
}

export async function findById(
  businessId: string,
  id: string,
  exec: Executor = db,
): Promise<Tag | null> {
  const [row] = await exec
    .select()
    .from(tags)
    .where(and(eq(tags.businessId, businessId), eq(tags.id, id)))
    .limit(1)
  return row ?? null
}

export async function insert(data: NewTag, exec: Executor = db): Promise<Tag> {
  const [row] = await exec.insert(tags).values(data).returning()
  if (!row) throw new Error('insert tags returned no row')
  return row
}

export type TagPatch = Partial<Pick<NewTag, 'name' | 'color'>>

export async function update(
  businessId: string,
  id: string,
  patch: TagPatch,
  exec: Executor = db,
): Promise<Tag | null> {
  const [row] = await exec
    .update(tags)
    .set(patch)
    .where(and(eq(tags.businessId, businessId), eq(tags.id, id)))
    .returning()
  return row ?? null
}

export async function remove(
  businessId: string,
  id: string,
  exec: Executor = db,
): Promise<string | null> {
  const [row] = await exec
    .delete(tags)
    .where(and(eq(tags.businessId, businessId), eq(tags.id, id)))
    .returning({ id: tags.id })
  // Assignments go with it through the cascade on conversation_tags.
  return row?.id ?? null
}

// ── Assignments ──────────────────────────────────────────────────────────────

export interface ConversationTagRow {
  conversationId: string
  tag: Tag
}

/**
 * The labels on a set of conversations, in one query.
 *
 * Takes the whole page rather than one conversation at a time: the inbox lists
 * twenty rows, and asking per row is twenty round trips to render one screen.
 *
 * Joined through `tags` and filtered on ITS business_id. conversation_tags
 * carries no tenant of its own, so this join is what keeps one business's
 * labels off another's conversations.
 */
export async function findForConversations(
  businessId: string,
  conversationIds: string[],
  exec: Executor = db,
): Promise<ConversationTagRow[]> {
  if (conversationIds.length === 0) return []

  const rows = await exec
    .select({ conversationId: conversationTags.conversationId, tag: tags })
    .from(conversationTags)
    .innerJoin(tags, eq(conversationTags.tagId, tags.id))
    .where(
      and(
        inArray(conversationTags.conversationId, conversationIds),
        eq(tags.businessId, businessId),
      ),
    )
    .orderBy(asc(tags.createdAt))

  return rows
}

/**
 * Replaces the whole label set of one conversation.
 *
 * Delete-then-insert inside the caller's transaction rather than diffing: the
 * UI holds the complete set, and a diff would be more code to reach the same
 * state. Callers pass a `tx` so a half-applied set is never visible.
 */
export async function replaceForConversation(
  conversationId: string,
  tagIds: string[],
  exec: Executor = db,
): Promise<void> {
  await exec.delete(conversationTags).where(eq(conversationTags.conversationId, conversationId))
  if (tagIds.length === 0) return
  await exec.insert(conversationTags).values(tagIds.map((tagId) => ({ conversationId, tagId })))
}

/**
 * Do all of these tag ids belong to this business?
 *
 * The guard behind assignment: the conversation id is checked against the
 * tenant separately, and this closes the other half, so a request cannot staple
 * another business's label onto its own thread.
 */
export async function allBelongToBusiness(
  businessId: string,
  tagIds: string[],
  exec: Executor = db,
): Promise<boolean> {
  if (tagIds.length === 0) return true
  const rows = await exec
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.businessId, businessId), inArray(tags.id, tagIds)))
  return rows.length === new Set(tagIds).size
}

/** Conversation ids carrying a given label. Used by the inbox filter. */
export async function conversationIdsForTag(
  businessId: string,
  tagId: string,
  exec: Executor = db,
): Promise<string[]> {
  const rows = await exec
    .select({ conversationId: conversationTags.conversationId })
    .from(conversationTags)
    .innerJoin(conversations, eq(conversationTags.conversationId, conversations.id))
    .where(and(eq(conversationTags.tagId, tagId), eq(conversations.businessId, businessId)))
  return rows.map((r) => r.conversationId)
}
