import { db, type Executor } from '@/db/client.js'
import { knowledgeBase, type KnowledgeBaseEntry } from '@/db/schema/index.js'
import { asc, eq } from 'drizzle-orm'

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
