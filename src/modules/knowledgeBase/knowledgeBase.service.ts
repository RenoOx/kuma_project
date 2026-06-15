import type { KnowledgeBaseEntry } from '@/db/schema/index.js'
import { AppError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as knowledgeBaseRepo from './knowledgeBase.repo.js'

export async function getByBusiness(
  businessId: string,
): Promise<Result<KnowledgeBaseEntry[]>> {
  try {
    const entries = await knowledgeBaseRepo.findByBusiness(businessId)
    return ok(entries)
  } catch (cause) {
    return err(
      new AppError({
        code: 'knowledge_base_get_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos cargar la información del negocio.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}
