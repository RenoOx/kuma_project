import { ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'

/** What a file IS, which decides its ceiling and how WhatsApp has to send it. */
export type MediaType = 'image' | 'pdf' | 'audio' | 'video'

/**
 * Per-type ceilings, in bytes.
 *
 * One number per type rather than one for everything: a price list is routinely
 * heavier than a photo, and a single 5MB ceiling was rejecting perfectly normal
 * PDFs. Video is the outlier and the reason this map exists at all — 16MB is
 * WhatsApp's own practical limit for an inline video, and anything above it
 * would be accepted here only to fail at send time.
 */
export const MAX_BYTES_BY_TYPE: Readonly<Record<MediaType, number>> = {
  image: 5 * 1024 * 1024,
  pdf: 10 * 1024 * 1024,
  audio: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
}

/** The largest any upload may be, whatever its type. Used to refuse before buffering. */
export const MAX_MEDIA_BYTES = Math.max(...Object.values(MAX_BYTES_BY_TYPE))

const HUMAN_LIMIT: Readonly<Record<MediaType, string>> = {
  image: '5MB',
  pdf: '10MB',
  audio: '5MB',
  video: '16MB',
}

export interface MediaFormat {
  mime: string
  ext: string
  type: MediaType
}

interface FormatSpec extends MediaFormat {
  matches: (buffer: Buffer) => boolean
}

function startsWith(buffer: Buffer, bytes: readonly number[]): boolean {
  if (buffer.length < bytes.length) return false
  return bytes.every((byte, i) => buffer[i] === byte)
}

/** RIFF container with a given four-character form type at offset 8. */
function isRiff(buffer: Buffer, form: string): boolean {
  return (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === form
  )
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
    type: 'image',
    matches: (b) => startsWith(b, [0xff, 0xd8, 0xff]),
  },
  {
    mime: 'image/png',
    ext: 'png',
    type: 'image',
    matches: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  {
    mime: 'image/webp',
    ext: 'webp',
    type: 'image',
    // RIFF container with a WEBP form type: "RIFF" ....(size).... "WEBP".
    matches: (b) => isRiff(b, 'WEBP'),
  },
  {
    mime: 'application/pdf',
    ext: 'pdf',
    type: 'pdf',
    matches: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
  },
  {
    mime: 'audio/wav',
    ext: 'wav',
    type: 'audio',
    // Same container as webp, different form type.
    matches: (b) => isRiff(b, 'WAVE'),
  },
  {
    mime: 'audio/ogg',
    ext: 'ogg',
    type: 'audio',
    // "OggS" page header.
    matches: (b) => startsWith(b, [0x4f, 0x67, 0x67, 0x53]),
  },
  {
    mime: 'video/mp4',
    ext: 'mp4',
    type: 'video',
    // ISO base media: a size field, then the 'ftyp' box type at offset 4. The
    // brand that follows varies (isom, mp42, M4V…) and is not worth pinning.
    matches: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp',
  },
  {
    mime: 'audio/mpeg',
    ext: 'mp3',
    type: 'audio',
    // Two legal openings: an ID3v2 tag, or a bare MPEG frame sync (eleven set
    // bits). Checked LAST because the frame-sync test is the loosest signature
    // here — two bytes — and anything with a real container must match its own
    // rule first rather than fall through to this one.
    matches: (b) =>
      startsWith(b, [0x49, 0x44, 0x33]) ||
      (b.length >= 2 && b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0),
  },
]

/** For the panel's file input `accept` attribute and for error messages. */
export const ACCEPTED_MIME_TYPES: readonly string[] = FORMATS.map((f) => f.mime)

export interface ValidatedMedia extends MediaFormat {
  bytes: number
}

/**
 * Checks an uploaded buffer against the format whitelist and its type's ceiling.
 *
 * The format is resolved BEFORE the size is judged, because the ceiling depends
 * on it: a 7MB file is fine as a PDF and too big as a photo, and there is no way
 * to say which without looking at the bytes first.
 *
 * The returned mime/ext/type come from the sniffed bytes, never from the caller,
 * and are what the key, the stored Content-Type and the WhatsApp send method are
 * built from.
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

  const format = FORMATS.find((candidate) => candidate.matches(buffer))
  if (!format) {
    return err(
      new ValidationError({
        code: 'media_unsupported_type',
        message: 'uploaded file did not match any accepted format signature',
        userMessage: 'Formato no permitido. Se aceptan JPG, PNG, WEBP, PDF, MP3, WAV, OGG y MP4.',
        logContext: { bytes: buffer.length },
      }),
    )
  }

  const ceiling = MAX_BYTES_BY_TYPE[format.type]
  if (buffer.length > ceiling) {
    return err(
      new ValidationError({
        code: 'media_too_large',
        message: `uploaded ${format.type} is ${buffer.length} bytes, over the ${ceiling} limit`,
        userMessage: `Ese archivo supera los ${HUMAN_LIMIT[format.type]} permitidos para ${format.type === 'pdf' ? 'un PDF' : `un ${format.type}`}.`,
        logContext: { bytes: buffer.length, maxBytes: ceiling, type: format.type },
      }),
    )
  }

  return ok({ mime: format.mime, ext: format.ext, type: format.type, bytes: buffer.length })
}
