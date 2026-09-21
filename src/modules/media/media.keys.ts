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

/** `{businessId}/services/{serviceId}_{index}.{ext}` */
export function buildServiceImageKey(
  businessId: string,
  serviceId: string,
  index: number,
  ext: string,
): Result<string> {
  if (!isSafeId(businessId)) return err(rejectId('businessId', businessId))
  if (!isSafeId(serviceId)) return err(rejectId('serviceId', serviceId))
  return ok(`${businessId}/services/${serviceId}_${index}.${ext}`)
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
  if (target.kind === 'service_image') {
    return buildServiceImageKey(target.businessId, target.serviceId, target.index ?? 1, ext)
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
