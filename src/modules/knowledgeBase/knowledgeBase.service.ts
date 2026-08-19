import type { KbCategory, KnowledgeBaseEntry } from '@/db/schema/index.js'
import { AppError, NotFoundError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import type { KnowledgeBasePatch } from './knowledgeBase.repo.js'
import * as knowledgeBaseRepo from './knowledgeBase.repo.js'
import { deriveTitle } from './knowledgeBase.types.js'

export async function getByBusiness(businessId: string): Promise<Result<KnowledgeBaseEntry[]>> {
  try {
    const entries = await knowledgeBaseRepo.findByBusiness(businessId)
    return ok(entries)
  } catch (cause) {
    return err(wrap(cause, 'knowledge_base_get_failed', { businessId }))
  }
}

export async function getById(businessId: string, id: string): Promise<Result<KnowledgeBaseEntry>> {
  try {
    const entry = await knowledgeBaseRepo.findById(businessId, id)
    if (!entry) {
      return err(
        new NotFoundError({ resource: 'knowledge_base entry', logContext: { businessId, id } }),
      )
    }
    return ok(entry)
  } catch (cause) {
    return err(wrap(cause, 'knowledge_base_get_failed', { businessId, id }))
  }
}

export interface CreateEntryInput {
  businessId: string
  title?: string | null
  category: KbCategory
  content: string
  attachmentType?: 'none' | 'link' | 'image' | 'pdf' | 'video'
  attachmentUrl?: string | null
  sendMode?: 'always' | 'on_request' | 'trigger_based'
  triggerKeywords?: string[] | null
  active?: boolean
}

export async function create(input: CreateEntryInput): Promise<Result<KnowledgeBaseEntry>> {
  try {
    const entry = await knowledgeBaseRepo.insert({
      ...input,
      // Title is optional for callers (CLI, demo profiles); derive it from the
      // content when absent, same rule the data migration used.
      title: input.title?.trim() || deriveTitle(input.content),
      triggerKeywords: normalizeKeywords(input.sendMode, input.triggerKeywords),
    })
    return ok(entry)
  } catch (cause) {
    return err(wrap(cause, 'knowledge_base_create_failed', { businessId: input.businessId }))
  }
}

export async function update(
  businessId: string,
  id: string,
  patch: KnowledgeBasePatch,
): Promise<Result<KnowledgeBaseEntry>> {
  try {
    const next: KnowledgeBasePatch = { ...patch }
    if (patch.sendMode !== undefined || patch.triggerKeywords !== undefined) {
      next.triggerKeywords = normalizeKeywords(patch.sendMode, patch.triggerKeywords ?? null)
    }
    const entry = await knowledgeBaseRepo.update(businessId, id, next)
    if (!entry) {
      return err(
        new NotFoundError({ resource: 'knowledge_base entry', logContext: { businessId, id } }),
      )
    }
    return ok(entry)
  } catch (cause) {
    return err(wrap(cause, 'knowledge_base_update_failed', { businessId, id }))
  }
}

export async function remove(businessId: string, id: string): Promise<Result<string>> {
  try {
    const deletedId = await knowledgeBaseRepo.remove(businessId, id)
    if (!deletedId) {
      return err(
        new NotFoundError({ resource: 'knowledge_base entry', logContext: { businessId, id } }),
      )
    }
    return ok(deletedId)
  } catch (cause) {
    return err(wrap(cause, 'knowledge_base_delete_failed', { businessId, id }))
  }
}

// Keywords only mean something for trigger_based entries. Storing them on the
// other modes would leave stale data that silently starts firing if the mode is
// switched back later.
function normalizeKeywords(
  sendMode: string | undefined,
  keywords: string[] | null | undefined,
): string[] | null {
  if (sendMode !== 'trigger_based') return null
  const cleaned = (keywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0)
  return cleaned.length > 0 ? cleaned : null
}

function wrap(cause: unknown, code: string, logContext: Record<string, unknown>): AppError {
  return new AppError({
    code,
    message: cause instanceof Error ? cause.message : 'unknown error',
    userMessage: 'No pudimos cargar la información del negocio.',
    logContext,
    cause,
  })
}
