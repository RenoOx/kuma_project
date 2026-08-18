import { logger } from '@/config/logger.js'
import type { KbCategory, KnowledgeBaseEntry } from '@/db/schema/index.js'
import type { Niche } from '@/modules/business/business.settings.js'
import { AppError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import { detectCategories, matchesTriggerKeywords } from './categoryDetector.js'
import * as knowledgeBaseRepo from './knowledgeBase.repo.js'

// Max entries pulled for the detected category on a single message.
export const MAX_ENTRIES_PER_QUERY = 5

// Selective KB retrieval. Two implementations behind one shape so the switch to
// RAG is a flag flip plus a backfill, not a rewrite of the callers.
//
// TODO: cuando se active RAG, cambiar KB_SEARCH_MODE=semantic y llenar
// embeddings via script de migración.

export interface SearchResult {
  entries: KnowledgeBaseEntry[]
  // Which categories drove the lookup. Empty means the detector found nothing
  // and the oldest-first fallback was used. Logged, not shown to the customer.
  matchedCategories: KbCategory[]
}

// Current implementation. Loads the detected category (capped at
// MAX_ENTRIES_PER_QUERY, oldest first) plus everything that is not gated on
// category: `always` entries always, `trigger_based` entries whose keywords hit
// the message.
//
// Note the consequence of the cap: past MAX_ENTRIES_PER_QUERY active entries in
// one category, the newest ones never reach the prompt. The admin panel warns
// the operator when a category crosses that line.
export async function searchByCategory(
  businessId: string,
  message: string,
  niche: Niche,
  limit: number = MAX_ENTRIES_PER_QUERY,
): Promise<Result<SearchResult>> {
  try {
    const categories = detectCategories(message, niche)

    const [categoryEntries, ungatedEntries] = await Promise.all([
      categories.length > 0
        ? knowledgeBaseRepo.findActiveByCategories(businessId, categories, limit)
        : knowledgeBaseRepo.findTopActive(businessId, limit),
      knowledgeBaseRepo.findAlwaysAndTriggerBased(businessId),
    ])

    // `on_request` entries only earn their place when their category matched.
    const gated = categoryEntries.filter((e) => e.sendMode !== 'trigger_based')
    const ungated = ungatedEntries.filter(
      (e) => e.sendMode === 'always' || matchesTriggerKeywords(message, e.triggerKeywords),
    )

    const byId = new Map<string, KnowledgeBaseEntry>()
    for (const entry of [...ungated, ...gated]) byId.set(entry.id, entry)

    const entries = [...byId.values()].sort(
      (a, b) => a.createdAt.getTime() - b.createdAt.getTime(),
    )

    return ok({ entries, matchedCategories: categories })
  } catch (cause) {
    return err(
      new AppError({
        code: 'knowledge_base_search_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos cargar la información del negocio.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}

// Placeholder for the RAG migration. The `embedding` column already exists (as
// jsonb) but is never written or read today, and there is no pgvector extension
// installed — so this deliberately fails loudly instead of silently returning
// nothing. llm.service falls back to searchByCategory when it sees this.
export async function searchBySimilarity(
  businessId: string,
  _queryEmbedding: number[],
  _limit: number = MAX_ENTRIES_PER_QUERY,
): Promise<Result<SearchResult>> {
  logger.warn(
    { component: 'knowledgeBaseSearch', businessId },
    'searchBySimilarity called but semantic search is not implemented',
  )
  return err(
    new AppError({
      code: 'kb_semantic_search_not_implemented',
      message:
        'semantic KB search is not implemented yet — the embedding column is a placeholder and pgvector is not installed',
      userMessage: 'No pudimos cargar la información del negocio.',
      logContext: { businessId },
    }),
  )
}
