import { logger } from '@/config/logger.js'
import { db } from '@/db/client.js'
import type { Tag } from '@/db/schema/index.js'
import * as panelRepo from '@/modules/panel/panel.repo.js'
import { AppError, ConflictError, NotFoundError, ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as tagRepo from './tag.repo.js'
import type { CreateTagInput, QualificationOutcome, TagColor, UpdateTagInput } from './tag.types.js'
import { MAX_TAGS_PER_BUSINESS, QUALIFICATION_TAGS } from './tag.types.js'

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

export async function create(businessId: string, input: CreateTagInput): Promise<Result<Tag>> {
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

// ── Calificación de leads ────────────────────────────────────────────────────
//
// La única vez que el CÓDIGO pone etiquetas (el resto las pone el dueño a mano).
// Ver QUALIFICATION_TAGS en tag.types.ts.

/**
 * La etiqueta con ese nombre; si no existe, la crea (respetando el límite de
 * 10). Fuera de cualquier transacción a propósito: si dos procesos la crean a
 * la vez, el UNIQUE rechaza a uno — y en Postgres un error adentro de una
 * transacción la deja abortada, sin poder volver a buscar. Acá el perdedor
 * simplemente la lee.
 */
async function ensureTag(
  businessId: string,
  spec: { name: string; color: TagColor },
): Promise<Result<Tag>> {
  const existing = await tagRepo.findByName(businessId, spec.name)
  if (existing) return ok(existing)

  const created = await create(businessId, spec)
  if (created.ok) return created
  if (created.error instanceof ConflictError) {
    const raced = await tagRepo.findByName(businessId, spec.name)
    if (raced) return ok(raced)
  }
  return created
}

/**
 * Le pone "Por validar" a la conversación sin tocar sus otras etiquetas. La
 * llama el handler cuando Emma se pausa porque llegó la captura o el DNI; la
 * conversación ya viene resuelta para este negocio.
 */
export async function markPendingValidation(
  businessId: string,
  conversationId: string,
): Promise<Result<void>> {
  try {
    const tag = await ensureTag(businessId, QUALIFICATION_TAGS.pending)
    if (!tag.ok) return tag
    await tagRepo.addToConversation(conversationId, tag.data.id)
    return ok(undefined)
  } catch (cause) {
    return err(wrap(cause, 'tag_mark_pending_failed', { businessId, conversationId }))
  }
}

/**
 * El dueño califica el lead desde el panel: sale "Por validar" (y el resultado
 * contrario, si estaba) y queda "Pagó" o "No pagó". El cambio va en una sola
 * transacción: el chat nunca queda un instante con las dos o con ninguna.
 */
export async function qualify(
  businessId: string,
  conversationId: string,
  outcome: QualificationOutcome,
): Promise<Result<Tag[]>> {
  try {
    const conversation = await panelRepo.findConversation(businessId, conversationId)
    if (!conversation) {
      return err(
        new NotFoundError({ resource: 'conversation', logContext: { businessId, conversationId } }),
      )
    }

    const target = await ensureTag(businessId, QUALIFICATION_TAGS[outcome])
    if (!target.ok) return target

    const opposite = QUALIFICATION_TAGS[outcome === 'paid' ? 'not_paid' : 'paid']
    const toRemove = await Promise.all([
      tagRepo.findByName(businessId, QUALIFICATION_TAGS.pending.name),
      tagRepo.findByName(businessId, opposite.name),
    ])

    await db.transaction(async (tx) => {
      await tagRepo.removeFromConversation(
        conversationId,
        toRemove.flatMap((tag) => (tag ? [tag.id] : [])),
        tx,
      )
      await tagRepo.addToConversation(conversationId, target.data.id, tx)
    })

    const rows = await tagRepo.findForConversations(businessId, [conversationId])
    return ok(rows.map((r) => r.tag))
  } catch (cause) {
    return err(wrap(cause, 'tag_qualify_failed', { businessId, conversationId, outcome }))
  }
}
