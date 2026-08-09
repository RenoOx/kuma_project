import { db, type Executor } from '@/db/client.js'
import {
  knowledgeBase,
  type KbCategory,
  type KnowledgeBaseEntry,
  type NewKnowledgeBaseEntry,
} from '@/db/schema/index.js'
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm'

export async function deleteByBusiness(
  businessId: string,
  exec: Executor = db,
): Promise<void> {
  await exec.delete(knowledgeBase).where(eq(knowledgeBase.businessId, businessId))
}

export async function bulkInsert(
  entries: NewKnowledgeBaseEntry[],
  exec: Executor = db,
): Promise<KnowledgeBaseEntry[]> {
  if (entries.length === 0) return []
  return await exec.insert(knowledgeBase).values(entries).returning()
}

export async function findByBusiness(
  businessId: string,
  exec: Executor = db,
): Promise<KnowledgeBaseEntry[]> {
  return await exec
    .select()
    .from(knowledgeBase)
    .where(eq(knowledgeBase.businessId, businessId))
    .orderBy(asc(knowledgeBase.category), desc(knowledgeBase.priority), asc(knowledgeBase.createdAt))
}

// Active entries of the given categories, most relevant first. `limit` caps the
// result for a single lookup — the caller decides how many categories it asks
// for.
export async function findActiveByCategories(
  businessId: string,
  categories: KbCategory[],
  limit: number,
  exec: Executor = db,
): Promise<KnowledgeBaseEntry[]> {
  if (categories.length === 0) return []
  return await exec
    .select()
    .from(knowledgeBase)
    .where(
      and(
        eq(knowledgeBase.businessId, businessId),
        eq(knowledgeBase.active, true),
        inArray(knowledgeBase.category, categories),
      ),
    )
    .orderBy(desc(knowledgeBase.priority), asc(knowledgeBase.createdAt))
    .limit(limit)
}

// Entries that are not gated on the detected category: `always` goes into every
// prompt by definition, and `trigger_based` is filtered in memory against the
// message (keyword arrays are small, and this keeps the SQL portable).
export async function findAlwaysAndTriggerBased(
  businessId: string,
  exec: Executor = db,
): Promise<KnowledgeBaseEntry[]> {
  return await exec
    .select()
    .from(knowledgeBase)
    .where(
      and(
        eq(knowledgeBase.businessId, businessId),
        eq(knowledgeBase.active, true),
        or(eq(knowledgeBase.sendMode, 'always'), eq(knowledgeBase.sendMode, 'trigger_based')),
      ),
    )
    .orderBy(desc(knowledgeBase.priority), asc(knowledgeBase.createdAt))
}

// Fallback when the detector matches no category: the highest-priority active
// entries regardless of category.
export async function findTopActive(
  businessId: string,
  limit: number,
  exec: Executor = db,
): Promise<KnowledgeBaseEntry[]> {
  return await exec
    .select()
    .from(knowledgeBase)
    .where(and(eq(knowledgeBase.businessId, businessId), eq(knowledgeBase.active, true)))
    .orderBy(desc(knowledgeBase.priority), asc(knowledgeBase.createdAt))
    .limit(limit)
}

// ── Admin CRUD ────────────────────────────────────────────────────────────────
// Every single-entry lookup takes businessId and filters on it alongside the id.
// An entry id alone must never be enough to read or mutate another tenant's row.

export async function findById(
  businessId: string,
  id: string,
  exec: Executor = db,
): Promise<KnowledgeBaseEntry | null> {
  const rows = await exec
    .select()
    .from(knowledgeBase)
    .where(and(eq(knowledgeBase.id, id), eq(knowledgeBase.businessId, businessId)))
    .limit(1)
  return rows[0] ?? null
}

export async function insert(
  entry: NewKnowledgeBaseEntry,
  exec: Executor = db,
): Promise<KnowledgeBaseEntry> {
  const rows = await exec.insert(knowledgeBase).values(entry).returning()
  const row = rows[0]
  if (!row) throw new Error('knowledge base insert returned no row')
  return row
}

export type KnowledgeBasePatch = Partial<
  Omit<NewKnowledgeBaseEntry, 'id' | 'businessId' | 'createdAt'>
>

export async function update(
  businessId: string,
  id: string,
  patch: KnowledgeBasePatch,
  exec: Executor = db,
): Promise<KnowledgeBaseEntry | null> {
  const rows = await exec
    .update(knowledgeBase)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(knowledgeBase.id, id), eq(knowledgeBase.businessId, businessId)))
    .returning()
  return rows[0] ?? null
}

export async function remove(
  businessId: string,
  id: string,
  exec: Executor = db,
): Promise<string | null> {
  const rows = await exec
    .delete(knowledgeBase)
    .where(and(eq(knowledgeBase.id, id), eq(knowledgeBase.businessId, businessId)))
    .returning({ id: knowledgeBase.id })
  return rows[0]?.id ?? null
}
