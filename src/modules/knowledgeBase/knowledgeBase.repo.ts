import { db, type Executor } from '@/db/client.js'
import { knowledgeBase, type KnowledgeBaseEntry, type NewKnowledgeBaseEntry } from '@/db/schema/index.js'
import { asc, eq } from 'drizzle-orm'

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
    .orderBy(asc(knowledgeBase.category), asc(knowledgeBase.createdAt))
}
