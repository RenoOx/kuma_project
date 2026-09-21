import { S3Client } from '@aws-sdk/client-s3'
import { env } from '@/config/env.js'
import { NotConfiguredError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'

export interface MediaConfig {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
}

/** Whether media storage can be used at all. The panel asks before offering an upload. */
export function isMediaConfigured(): boolean {
  return Boolean(
    env.AWS_ACCESS_KEY_ID &&
      env.AWS_SECRET_ACCESS_KEY &&
      env.AWS_S3_BUCKET_NAME &&
      env.AWS_S3_REGION,
  )
}

/**
 * The credentials, or a NotConfiguredError naming exactly which vars are absent.
 *
 * The four env vars are optional at boot on purpose (see config/env.ts), so this
 * is where a business that tries to use storage on an unconfigured deploy finds
 * out — with the same error type the rest of the codebase already uses for a
 * business missing settings.
 */
export function requireMediaConfig(businessId: string): Result<MediaConfig> {
  const accessKeyId = env.AWS_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY
  const bucket = env.AWS_S3_BUCKET_NAME
  const region = env.AWS_S3_REGION

  const missing: string[] = []
  if (!accessKeyId) missing.push('AWS_ACCESS_KEY_ID')
  if (!secretAccessKey) missing.push('AWS_SECRET_ACCESS_KEY')
  if (!bucket) missing.push('AWS_S3_BUCKET_NAME')
  if (!region) missing.push('AWS_S3_REGION')

  if (!accessKeyId || !secretAccessKey || !bucket || !region) {
    return err(
      new NotConfiguredError({
        businessId,
        missing,
        userMessage: 'El almacenamiento de archivos no está configurado.',
      }),
    )
  }

  // Checked here rather than left to AWS, because AWS answers a malformed name
  // with a generic failure at upload time — by which point the owner has picked
  // a file and is watching a spinner. `emma_media_prod` is a real example: S3
  // bucket names take no underscores, so that name can never exist, and the
  // deploy would have failed every single upload with no hint as to why.
  if (!isValidBucketName(bucket)) {
    return err(
      new NotConfiguredError({
        businessId,
        missing: ['AWS_S3_BUCKET_NAME'],
        userMessage: 'El almacenamiento de archivos está mal configurado.',
      }),
    )
  }

  return ok({ bucket, region, accessKeyId, secretAccessKey })
}

/**
 * The subset of S3's naming rules that catches real typos.
 *
 * Lowercase letters, digits, dots and hyphens; 3 to 63 characters; starts and
 * ends with a letter or a digit. Not exhaustive — S3 also rejects IP-shaped
 * names and a few reserved prefixes — but those are not what anyone types by
 * accident. Underscores and capitals are.
 */
export function isValidBucketName(name: string): boolean {
  return /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)
}

let cached: S3Client | null = null

/**
 * The shared client, built on first use rather than at import.
 *
 * Same reason google.client builds its OAuth client lazily: a module-level
 * client would make importing anything in this folder depend on AWS being
 * configured, and the whole point of the optional env vars is that a deploy
 * without them still boots.
 */
export function getS3Client(config: MediaConfig): S3Client {
  if (!cached) {
    cached = new S3Client({
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    })
  }
  return cached
}
