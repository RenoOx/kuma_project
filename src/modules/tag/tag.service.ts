import { logger } from '@/config/logger.js'
import { db } from '@/db/client.js'
import type { Tag } from '@/db/schema/index.js'
import * as panelRepo from '@/modules/panel/panel.repo.js'
import { AppError, ConflictError, NotFoundError, ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as tagRepo from './tag.repo.js'
import { MAX_TAGS_PER_BUSINESS } from './tag.types.js'
import type { CreateTagInput, UpdateTagInput } from './tag.types.js'

function wrap(cause: unknown, code: string, logContext: Record<string, unknown>): AppError {
  return new AppError({
    code,
    message: cause instanceof Error ? cause.message : 'unknown error',
    userMessage: 'No pudimos guardar las etiquetas.',
    logContext,
    cause,
  })
}

// Postgres surfaces the unique index as this. Caught by name rather than by
// checking for an existing row first, which would race two tabs saving at once.
function isUniqueViolation(cause: unknown): boolean {
  return typeof cause === 'object' && cause !== null && 'code' in cause && cause.code === '23505'
}

export async function list(businessId: string): Promise<Result<Tag[]>> {
  try {
    return ok(await tagRepo.findByBusiness(businessId))
  } catch (cause) {
    return err(wrap(cause, 'tags_list_failed', { businessId }))
  }
}

export async function create(
  businessId: string,
  input: CreateTagInput,
): Promise<Result<Tag>> {
  try {
    const count = await tagRepo.countByBusiness(businessId)
    if (count >= MAX_TAGS_PER_BUSINESS) {
      return err(
        new ValidationError({
          code: 'tag_limit_reached',
          message: `business ${businessId} already has ${count} tags`,
          userMessage: `Llegaste al máximo de ${MAX_TAGS_PER_BUSINESS} etiquetas. Borrá una para crear otra.`,
          logContext: { businessId, count },
        }),
      )
    }

    return ok(await tagRepo.insert({ businessId, ...input }))
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      return err(
        new ConflictError({
          message: `duplicate tag name for business ${businessId}`,
          userMessage: 'Ya tenés una etiqueta con ese nombre.',
          logContext: { businessId },
          cause,
        }),
      )
    }
    return err(wrap(cause, 'tag_create_failed', { businessId }))
  }
}

export async function update(
  businessId: string,
  id: string,
  patch: UpdateTagInput,
): Promise<Result<Tag>> {
  try {
    const updated = await tagRepo.update(businessId, id, patch)
    if (!updated) {
      return err(new NotFoundError({ resource: 'tag', logContext: { businessId, id } }))
    }
    return ok(updated)
  } catch (cause) {
    if (isUniqueViolation(cause)) {
      return err(
        new ConflictError({
          message: `duplicate tag name for business ${businessId}`,
          userMessage: 'Ya tenés una etiqueta con ese nombre.',
          logContext: { businessId, id },
          cause,
        }),
      )
    }
    return err(wrap(cause, 'tag_update_failed', { businessId, id }))
  }
}

export async function remove(businessId: string, id: string): Promise<Result<string>> {
  try {
    const deleted = await tagRepo.remove(businessId, id)
    if (!deleted) {
      return err(new NotFoundError({ resource: 'tag', logContext: { businessId, id } }))
    }
    logger.info({ businessId, tagId: id }, 'tag deleted')
    return ok(deleted)
  } catch (cause) {
    return err(wrap(cause, 'tag_delete_failed', { businessId, id }))
  }
}

/**
 * Sets the labels on one conversation.
 *
 * Two tenant checks, because there are two ids in play and each could belong to
 * someone else: the conversation is looked up through panelRepo (which filters
 * on business_id), and every tag id is verified to belong to the same business.
 * Without the second, a request could staple another business's label onto its
 * own thread — conversation_tags has no tenant column to catch it later.
 */
export async function assign(
  businessId: string,
  conversationId: string,
  tagIds: string[],
): Promise<Result<Tag[]>> {
  try {
    const conversation = await panelRepo.findConversation(businessId, conversationId)
    if (!conversation) {
      return err(
        new NotFoundError({ resource: 'conversation', logContext: { businessId, conversationId } }),
      )
    }

    const owned = await tagRepo.allBelongToBusiness(businessId, tagIds)
    if (!owned) {
      return err(
        new ValidationError({
          code: 'unknown_tag',
          message: 'tag ids do not all belong to this business',
          userMessage: 'Alguna de esas etiquetas ya no existe.',
          logContext: { businessId, conversationId },
        }),
      )
    }

    await db.transaction(async (tx) => {
      await tagRepo.replaceForConversation(conversationId, tagIds, tx)
    })

    const rows = await tagRepo.findForConversations(businessId, [conversationId])
    return ok(rows.map((r) => r.tag))
  } catch (cause) {
    return err(wrap(cause, 'tag_assign_failed', { businessId, conversationId }))
  }
}
