import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { AppError, ValidationError } from '@/shared/errors.js'
import { err, isErr, ok, type Result } from '@/shared/result.js'
import { buildKey, keyBelongsTo } from './media.keys.js'
import type { MediaTarget, UploadedMedia } from './media.types.js'
import { validateMedia } from './media.validate.js'
import { getS3Client, requireMediaConfig } from './s3.client.js'

/**
 * Object storage for service images and payment proofs.
 *
 * Nothing here throws: every function returns a Result, so a bucket that is
 * down or unconfigured degrades the one feature that needs it instead of
 * breaking a WhatsApp reply or a panel save.
 *
 * Two tenant defences, both mandatory. Uploads never take a caller-supplied
 * key — they take a MediaTarget and build the key from validated ids. Reads and
 * deletes take the businessId alongside the key and refuse anything outside its
 * prefix, so a key that came back out of the database still gets checked before
 * it is signed.
 */

/** Presigned URLs expire in an hour. Never make the bucket public. */
export const DEFAULT_URL_EXPIRY_SECONDS = 3600

function wrap(cause: unknown, code: string, logContext: Record<string, unknown>): AppError {
  return new AppError({
    code,
    message: cause instanceof Error ? cause.message : `${code} failed`,
    userMessage: 'No pudimos procesar el archivo. Intentá de nuevo.',
    logContext,
    cause,
  })
}

function assertOwned(businessId: string, key: string): Result<void> {
  if (keyBelongsTo(businessId, key)) return ok(undefined)
  return err(
    new ValidationError({
      code: 'media_key_foreign',
      message: 'media key does not belong to this business',
      userMessage: 'No pudimos ubicar ese archivo.',
      logContext: { businessId, key },
    }),
  )
}

export async function uploadMedia(
  target: MediaTarget,
  buffer: Buffer,
): Promise<Result<UploadedMedia>> {
  const config = requireMediaConfig(target.businessId)
  if (isErr(config)) return config

  const validated = validateMedia(buffer)
  if (isErr(validated)) return validated

  const key = buildKey(target, validated.data.ext)
  if (isErr(key)) return key

  try {
    await getS3Client(config.data).send(
      new PutObjectCommand({
        Bucket: config.data.bucket,
        Key: key.data,
        Body: buffer,
        ContentType: validated.data.mime,
      }),
    )
  } catch (cause) {
    return err(
      wrap(cause, 'media_upload_failed', {
        businessId: target.businessId,
        kind: target.kind,
        key: key.data,
      }),
    )
  }

  return ok({
    key: key.data,
    mime: validated.data.mime,
    type: validated.data.type,
    bytes: validated.data.bytes,
  })
}

export async function getPresignedUrl(
  businessId: string,
  key: string,
  expiresIn: number = DEFAULT_URL_EXPIRY_SECONDS,
): Promise<Result<string>> {
  const owned = assertOwned(businessId, key)
  if (isErr(owned)) return owned

  const config = requireMediaConfig(businessId)
  if (isErr(config)) return config

  try {
    const url = await getSignedUrl(
      getS3Client(config.data),
      new GetObjectCommand({ Bucket: config.data.bucket, Key: key }),
      { expiresIn },
    )
    return ok(url)
  } catch (cause) {
    return err(wrap(cause, 'media_sign_failed', { businessId, key }))
  }
}

export async function removeMedia(businessId: string, key: string): Promise<Result<void>> {
  const owned = assertOwned(businessId, key)
  if (isErr(owned)) return owned

  const config = requireMediaConfig(businessId)
  if (isErr(config)) return config

  try {
    await getS3Client(config.data).send(
      new DeleteObjectCommand({ Bucket: config.data.bucket, Key: key }),
    )
    return ok(undefined)
  } catch (cause) {
    return err(wrap(cause, 'media_delete_failed', { businessId, key }))
  }
}

/** Reads an object back, for relaying a stored image over WhatsApp. */
export async function downloadMedia(businessId: string, key: string): Promise<Result<Buffer>> {
  const owned = assertOwned(businessId, key)
  if (isErr(owned)) return owned

  const config = requireMediaConfig(businessId)
  if (isErr(config)) return config

  try {
    const response = await getS3Client(config.data).send(
      new GetObjectCommand({ Bucket: config.data.bucket, Key: key }),
    )
    if (!response.Body) {
      return err(wrap(new Error('empty body'), 'media_download_failed', { businessId, key }))
    }
    const bytes = await response.Body.transformToByteArray()
    return ok(Buffer.from(bytes))
  } catch (cause) {
    return err(wrap(cause, 'media_download_failed', { businessId, key }))
  }
}
