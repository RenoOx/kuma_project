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

/**
 * What an AWS failure actually means, for the log.
 *
 * Three of these are configuration, not bad luck, and telling them apart is the
 * difference between a one-line fix and an afternoon. `PermanentRedirect` cost
 * exactly that on 2026-09-21: AWS_S3_REGION said us-east-1, the bucket lived in
 * us-east-2, and every upload came back as "No pudimos procesar el archivo" —
 * a message that describes a transient hiccup and sends you looking in the
 * wrong place entirely.
 *
 * Returns null when the error is not one we can name, so the generic path stays.
 */
function diagnose(cause: unknown): string | null {
  const name = cause instanceof Error ? cause.name : ''
  switch (name) {
    case 'PermanentRedirect':
      return 'AWS_S3_REGION no coincide con la región real del bucket. Consultala con: curl -sI https://<bucket>.s3.amazonaws.com | grep x-amz-bucket-region'
    case 'NoSuchBucket':
      return 'El bucket de AWS_S3_BUCKET_NAME no existe en esa cuenta.'
    case 'AccessDenied':
    case 'InvalidAccessKeyId':
    case 'SignatureDoesNotMatch':
      return 'Las credenciales de AWS no tienen permiso sobre este bucket, o son de otra cuenta.'
    default:
      return null
  }
}

function wrap(cause: unknown, code: string, logContext: Record<string, unknown>): AppError {
  const diagnosis = diagnose(cause)
  return new AppError({
    code,
    message: cause instanceof Error ? cause.message : `${code} failed`,
    // A misconfiguration is not something the owner can retry their way out of,
    // so it must not say "intentá de nuevo" — that is how a broken deploy looks
    // like a flaky one for a week.
    userMessage: diagnosis
      ? 'El almacenamiento de archivos está mal configurado. Escribinos a Vamvu Labs.'
      : 'No pudimos procesar el archivo. Intentá de nuevo.',
    logContext: {
      ...logContext,
      awsError: cause instanceof Error ? cause.name : 'unknown',
      ...(diagnosis ? { diagnosis } : {}),
    },
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
