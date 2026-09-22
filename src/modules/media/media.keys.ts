import { ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import type { MediaTarget } from './media.types.js'

/**
 * Shape of every id that may appear in a key.
 *
 * Matches the nanoid alphabet (A-Za-z0-9_-) and nothing else, which is what
 * makes a key safe by construction: no slashes, no dots, no `..`, so no upload
 * can climb out of its tenant prefix.
 *
 * Note these ids are NOT slugified. Lowercasing them or collapsing `_` to `-`
 * would map two distinct nanoids onto the same path — `aB_c` and `ab-c` would
 * collide and one business's image would overwrite another's. Filenames here are
 * composed from validated ids rather than from anything the uploader typed, so
 * they are already free of spaces and special characters.
 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export function isSafeId(value: string): boolean {
  return SAFE_ID.test(value)
}

function rejectId(field: string, value: string): ValidationError {
  return new ValidationError({
    code: 'invalid_media_id',
    message: `${field} is not a valid media path segment`,
    userMessage: 'No pudimos ubicar ese archivo.',
    // The value is an id, not user content — safe to log and needed to debug.
    logContext: { field, value },
  })
}

/**
 * `{businessId}/services/{serviceId}/{mediaId}.{ext}`
 *
 * A folder per service, not `{serviceId}_{index}` flat. The flat layout could
 * only ever hold one numbered slot per service; a folder holds a photo, a price
 * list and a voice note side by side. It also makes "delete everything this
 * service owns" a prefix, which is what the orphan sweep needs.
 *
 * The filename is the id of the `service_media` row, so object and row point at
 * each other by construction — see MediaTarget.
 */
export function buildServiceMediaKey(
  businessId: string,
  serviceId: string,
  mediaId: string,
  ext: string,
): Result<string> {
  if (!isSafeId(businessId)) return err(rejectId('businessId', businessId))
  if (!isSafeId(serviceId)) return err(rejectId('serviceId', serviceId))
  if (!isSafeId(mediaId)) return err(rejectId('mediaId', mediaId))
  return ok(`${businessId}/services/${serviceId}/${mediaId}.${ext}`)
}

/** Everything one service owns, for a bulk delete. Trailing slash is required. */
export function serviceMediaPrefix(businessId: string, serviceId: string): Result<string> {
  if (!isSafeId(businessId)) return err(rejectId('businessId', businessId))
  if (!isSafeId(serviceId)) return err(rejectId('serviceId', serviceId))
  return ok(`${businessId}/services/${serviceId}/`)
}

/**
 * `{businessId}/nodes/{nodeId}/{mediaId}.{ext}`
 *
 * A prefix of its own rather than reusing `services/`: a node id and a service
 * id are both nanoids and could collide, and "delete everything this step owns"
 * has to be a prefix that cannot sweep a service's folder with it.
 */
export function buildNodeMediaKey(
  businessId: string,
  nodeId: string,
  mediaId: string,
  ext: string,
): Result<string> {
  if (!isSafeId(businessId)) return err(rejectId('businessId', businessId))
  if (!isSafeId(nodeId)) return err(rejectId('nodeId', nodeId))
  if (!isSafeId(mediaId)) return err(rejectId('mediaId', mediaId))
  return ok(`${businessId}/nodes/${nodeId}/${mediaId}.${ext}`)
}

/** `{businessId}/payments/{conversationId}_{timestamp}.{ext}` */
export function buildPaymentProofKey(
  businessId: string,
  conversationId: string,
  at: Date,
  ext: string,
): Result<string> {
  if (!isSafeId(businessId)) return err(rejectId('businessId', businessId))
  if (!isSafeId(conversationId)) return err(rejectId('conversationId', conversationId))
  return ok(`${businessId}/payments/${conversationId}_${at.getTime()}.${ext}`)
}

export function buildKey(target: MediaTarget, ext: string): Result<string> {
  if (target.kind === 'service_media') {
    return buildServiceMediaKey(target.businessId, target.serviceId, target.mediaId, ext)
  }
  if (target.kind === 'node_media') {
    return buildNodeMediaKey(target.businessId, target.nodeId, target.mediaId, ext)
  }
  return buildPaymentProofKey(
    target.businessId,
    target.conversationId,
    target.at ?? new Date(),
    ext,
  )
}

/**
 * Whether a key sits under a business's own prefix.
 *
 * The second of the two tenant defences. The first is that keys are built here
 * from validated ids rather than accepted from callers; this one guards the read
 * and delete paths, where a key read back out of the database is about to be
 * signed or removed. A business that somehow names another's object gets a
 * refusal instead of a working URL.
 */
export function keyBelongsTo(businessId: string, key: string): boolean {
  if (!isSafeId(businessId)) return false
  if (key.includes('..')) return false
  return key.startsWith(`${businessId}/`)
}
