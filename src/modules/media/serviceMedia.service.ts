import { nanoid } from 'nanoid'
import { logger } from '@/config/logger.js'
import { db } from '@/db/client.js'
import type { ServiceMedia } from '@/db/schema/index.js'
import { AppError, NotFoundError } from '@/shared/errors.js'
import { err, isErr, ok, type Result } from '@/shared/result.js'
import * as mediaService from './media.service.js'
import type { MediaOwnerKind, MediaTarget } from './media.types.js'
import * as repo from './serviceMedia.repo.js'

/**
 * The CRUD of a service's, a conversation step's, or a fixed message's files,
 * with the bucket and the table kept in step.
 *
 * The three owners share one table and one code path. What tells them apart is
 * `ownerKind`, which is required everywhere it matters - a service id and a node
 * id are both nanoids, so an unscoped query would cross them.
 *
 * Two stores have to agree here and only one of them has transactions. The rule
 * that keeps them consistent is: **the flaky side goes inside the transaction.**
 *
 * - Creating: the object is written FIRST, then the row. If the row fails, the
 *   object is deleted — there is nothing to roll back to but the bucket.
 * - Deleting: the row is deleted inside a transaction and the object is dropped
 *   INSIDE it. If S3 refuses, the transaction rolls back and the row survives.
 *   The owner gets an error and can retry, and neither store is left holding a
 *   file the other does not know about.
 *
 * That ordering is what makes "no residue" a property rather than a hope. The
 * other order — row first, object best-effort — leaves an invisible object in
 * the bucket every time S3 hiccups, and nothing ever looks for it again.
 */

export interface ServiceMediaInput {
  businessId: string
  /**
   * 'service' for a catalogue item, 'node' for a step of the conversation,
   * 'fixedMessage' for a mensaje fijo declarado en el archivo del negocio.
   */
  ownerKind: MediaOwnerKind
  /** El nanoid del servicio, el id del nodo, o el id del mensaje fijo. */
  ownerId: string
  filename: string | null
  buffer: Buffer
}

/**
 * Stores one file for a service or for a conversation step.
 *
 * The row id is minted before the upload and becomes the object's filename, so
 * the two point at each other by construction rather than by convention.
 */
export async function addMedia(input: ServiceMediaInput): Promise<Result<ServiceMedia>> {
  const mediaId = nanoid()

  const target: MediaTarget =
    input.ownerKind === 'node'
      ? { kind: 'node_media', businessId: input.businessId, nodeId: input.ownerId, mediaId }
      : input.ownerKind === 'fixedMessage'
        ? {
            kind: 'fixed_message_media',
            businessId: input.businessId,
            messageId: input.ownerId,
            mediaId,
          }
        : { kind: 'service_media', businessId: input.businessId, serviceId: input.ownerId, mediaId }

  const uploaded = await mediaService.uploadMedia(target, input.buffer)
  if (isErr(uploaded)) return uploaded

  const existing = await repo.listByOwner(input.businessId, input.ownerKind, input.ownerId)

  try {
    const row = await repo.insert({
      id: mediaId,
      businessId: input.businessId,
      ownerKind: input.ownerKind,
      serviceId: input.ownerId,
      s3Key: uploaded.data.key,
      type: uploaded.data.type,
      filename: input.filename,
      mimetype: uploaded.data.mime,
      sizeBytes: uploaded.data.bytes,
      // Appended, not inserted: a new file never reorders the ones the owner
      // already arranged.
      displayOrder: existing.length,
    })
    return ok(row)
  } catch (cause) {
    // The object is already in the bucket and nothing references it. Drop it
    // now, while we still hold its key — after this stack unwinds nobody knows
    // it exists.
    const cleaned = await mediaService.removeMedia(input.businessId, uploaded.data.key)
    if (isErr(cleaned)) {
      logger.error(
        { businessId: input.businessId, key: uploaded.data.key, code: cleaned.error.code },
        'orphaned object: row insert failed and the compensating delete failed too',
      )
    }
    return err(
      new AppError({
        code: 'service_media_insert_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos guardar el archivo. Intentá de nuevo.',
        logContext: {
          businessId: input.businessId,
          ownerKind: input.ownerKind,
          ownerId: input.ownerId,
        },
        cause,
      }),
    )
  }
}

/**
 * Removes one file, from both stores or from neither.
 *
 * The S3 delete runs inside the transaction on purpose: throwing there rolls the
 * row back, so a bucket that refuses leaves the owner exactly where they were
 * instead of leaving a file nobody can see or reach.
 */
export async function removeOne(
  businessId: string,
  mediaId: string,
): Promise<Result<ServiceMedia>> {
  try {
    return await db.transaction(async (tx) => {
      const row = await repo.remove(businessId, mediaId, tx)
      if (!row) {
        return err(
          new NotFoundError({
            resource: 'service_media',
            logContext: { businessId, mediaId },
          }),
        )
      }

      const dropped = await mediaService.removeMedia(businessId, row.s3Key)
      if (isErr(dropped)) throw dropped.error

      return ok(row)
    })
  } catch (cause) {
    return err(asFailure(cause, { businessId, mediaId }))
  }
}

/** Everything one owner owns. Same all-or-nothing rule as removeOne. */
export async function removeForOwner(
  businessId: string,
  ownerKind: MediaOwnerKind,
  ownerId: string,
): Promise<Result<number>> {
  try {
    return await db.transaction(async (tx) => {
      const rows = await repo.removeByOwner(businessId, ownerKind, ownerId, tx)
      for (const row of rows) {
        const dropped = await mediaService.removeMedia(businessId, row.s3Key)
        if (isErr(dropped)) throw dropped.error
      }
      return ok(rows.length)
    })
  } catch (cause) {
    return err(asFailure(cause, { businessId, ownerKind, ownerId }))
  }
}

/**
 * Deletes the files of owners that no longer exist.
 *
 * Called whenever the owning list is saved. Neither services nor conversation
 * steps are rows: both live inside the settings jsonb as a replaced array, so
 * nothing ever announces "this one was deleted" - it just stops being in the
 * list. Without this sweep, removing one from the panel would leave its files in
 * the bucket and its rows in the table forever, referenced by nothing.
 *
 * SCOPED BY `ownerKind`. Saving the services list must not reach a step's files,
 * and saving the flow must not reach a service's: the two lists know nothing
 * about each other, so a sweep that saw both would read every row of the other
 * kind as an orphan and delete it.
 *
 * Never fails its caller: a settings save that succeeded must not be reported as
 * an error because a cleanup could not finish. A sweep that fails is retried by
 * the next save, since it works from the current list rather than from an event.
 */
export async function purgeOrphans(
  businessId: string,
  ownerKind: MediaOwnerKind,
  keepIds: string[],
): Promise<number> {
  try {
    return await db.transaction(async (tx) => {
      const rows = await repo.removeOrphans(businessId, ownerKind, keepIds, tx)
      for (const row of rows) {
        const dropped = await mediaService.removeMedia(businessId, row.s3Key)
        if (isErr(dropped)) throw dropped.error
      }
      if (rows.length > 0) {
        logger.info(
          { businessId, ownerKind, removed: rows.length },
          'purged media of owners that no longer exist',
        )
      }
      return rows.length
    })
  } catch (cause) {
    logger.warn(
      { businessId, ownerKind, err: cause },
      'could not purge orphaned media; the next save will retry',
    )
    return 0
  }
}

export function listForOwner(
  businessId: string,
  ownerKind: MediaOwnerKind,
  ownerId: string,
): Promise<ServiceMedia[]> {
  return repo.listByOwner(businessId, ownerKind, ownerId)
}

export function listForBusiness(
  businessId: string,
  ownerKind: MediaOwnerKind | null = null,
): Promise<ServiceMedia[]> {
  return repo.listByBusiness(businessId, ownerKind)
}

/**
 * Applies an order the owner arranged.
 *
 * Takes the full list of ids rather than a pair to swap: the panel owns the
 * arrangement and sends it whole, so a request that lost a row cannot leave two
 * files claiming the same position.
 */
export async function reorder(
  businessId: string,
  ownerKind: MediaOwnerKind,
  ownerId: string,
  orderedIds: string[],
): Promise<Result<ServiceMedia[]>> {
  try {
    return await db.transaction(async (tx) => {
      const current = await repo.listByOwner(businessId, ownerKind, ownerId, tx)
      const known = new Set(current.map((r) => r.id))
      if (orderedIds.length !== current.length || orderedIds.some((id) => !known.has(id))) {
        return err(
          new AppError({
            code: 'service_media_reorder_mismatch',
            message: 'reorder payload does not match the stored media of this owner',
            userMessage: 'La lista cambió mientras la ordenabas. Recargá y probá de nuevo.',
            logContext: {
              businessId,
              ownerKind,
              ownerId,
              sent: orderedIds.length,
              stored: current.length,
            },
          }),
        )
      }

      for (const [index, id] of orderedIds.entries()) {
        await repo.setDisplayOrder(businessId, id, index, tx)
      }
      return ok(await repo.listByOwner(businessId, ownerKind, ownerId, tx))
    })
  } catch (cause) {
    return err(asFailure(cause, { businessId, ownerKind, ownerId }))
  }
}

function asFailure(cause: unknown, logContext: Record<string, unknown>): AppError {
  if (cause instanceof AppError) return cause
  return new AppError({
    code: 'service_media_operation_failed',
    message: cause instanceof Error ? cause.message : 'unknown error',
    userMessage: 'No pudimos actualizar los archivos. Intentá de nuevo.',
    logContext,
    cause,
  })
}
