import { ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'

/** Per-file ceiling from the media spec. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024

export interface MediaFormat {
  mime: string
  ext: string
}

interface FormatSpec extends MediaFormat {
  matches: (buffer: Buffer) => boolean
}

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false
  return bytes.every((byte, i) => buffer[i] === byte)
}

/**
 * The accepted formats, recognised by their leading bytes.
 *
 * Sniffed rather than trusted: both the multipart content-type and the filename
 * extension are set by whoever is uploading, so a bucket that believes them is a
 * bucket that will happily store an executable someone named `.jpg` and hand it
 * back over a presigned URL. The bytes are the only part of an upload the
 * uploader cannot lie about.
 *
 * jpg and jpeg are one format with one extension — the spec lists both spellings
 * of the same thing.
 */
const FORMATS: readonly FormatSpec[] = [
  {
    mime: 'image/jpeg',
    ext: 'jpg',
    matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  {
    mime: 'image/png',
    ext: 'png',
    matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    // RIFF container with a WEBP form type: "RIFF" ....(size).... "WEBP".
    matches: (b) =>
      b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    mime: 'application/pdf',
    ext: 'pdf',
    matches: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  },
]

/** For the panel's file input `accept` attribute and for error messages. */
export const ACCEPTED_MIME_TYPES: readonly string[] = FORMATS.map((f) => f.mime)

export interface ValidatedMedia extends MediaFormat {
  bytes: number
}

/**
 * Checks an uploaded buffer against the size ceiling and the format whitelist.
 *
 * The returned mime/ext come from the sniffed bytes, never from the caller, and
 * are what the key and the stored Content-Type are built from.
 *
 * Distinct codes so routes can map them to distinct statuses (413 vs 415)
 * instead of collapsing every rejection into one 400.
 */
export function validateMedia(buffer: Buffer): Result<ValidatedMedia> {
  if (buffer.length === 0) {
    return err(
      new ValidationError({
        code: 'media_empty',
        message: 'uploaded file is empty',
        userMessage: 'El archivo está vacío.',
      }),
    )
  }

  if (buffer.length > MAX_MEDIA_BYTES) {
    return err(
      new ValidationError({
        code: 'media_too_large',
        message: `uploaded file is ${buffer.length} bytes, over the ${MAX_MEDIA_BYTES} limit`,
        userMessage: 'El archivo supera los 5MB.',
        logContext: { bytes: buffer.length, maxBytes: MAX_MEDIA_BYTES },
      }),
    )
  }

  const format = FORMATS.find((candidate) => candidate.matches(buffer))
  if (!format) {
    return err(
      new ValidationError({
        code: 'media_unsupported_type',
        message: 'uploaded file did not match any accepted format signature',
        userMessage: 'Formato no permitido. Se aceptan JPG, PNG, WEBP y PDF.',
        logContext: { bytes: buffer.length },
      }),
    )
  }

  return ok({ mime: format.mime, ext: format.ext, bytes: buffer.length })
}
