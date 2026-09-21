import { describe, expect, it } from 'vitest'
import { MAX_BYTES_BY_TYPE, MAX_MEDIA_BYTES, validateMedia } from './media.validate.js'
import { isValidBucketName } from './s3.client.js'

describe('bucket names', () => {
  it('accepts the buckets this project actually uses', () => {
    expect(isValidBucketName('emma-media-dev')).toBe(true)
    expect(isValidBucketName('emma-media-prod')).toBe(true)
  })

  it('rejects underscores, which S3 does not allow and people type anyway', () => {
    // A real one: `emma_media_prod` was named in conversation on 2026-09-21. It
    // can never exist, and without this check every upload on that deploy would
    // have failed with nothing pointing at the name.
    expect(isValidBucketName('emma_media_prod')).toBe(false)
  })

  it('rejects capitals and names that are too short or badly bounded', () => {
    expect(isValidBucketName('Emma-Media-Prod')).toBe(false)
    expect(isValidBucketName('ab')).toBe(false)
    expect(isValidBucketName('-emma-media')).toBe(false)
    expect(isValidBucketName('emma-media-')).toBe(false)
  })
})

// The format whitelist is the only thing standing between an upload and the
// bucket. Content-type and filename both come from whoever is uploading, so the
// leading bytes are the one part they cannot lie about — these tests pin that
// the sniffing actually distinguishes the formats, including the three pairs
// that share a container or a prefix.

/** A buffer that starts with `head` and is padded to `size`. */
function file(head: readonly number[], size = 64): Buffer {
  const buffer = Buffer.alloc(size)
  head.forEach((byte, i) => {
    buffer[i] = byte
  })
  return buffer
}

function riff(form: string, size = 64): Buffer {
  const buffer = Buffer.alloc(size)
  buffer.write('RIFF', 0, 'ascii')
  buffer.write(form, 8, 'ascii')
  return buffer
}

const JPEG = file([0xff, 0xd8, 0xff])
const PNG = file([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PDF = file([0x25, 0x50, 0x44, 0x46, 0x2d])
const OGG = file([0x4f, 0x67, 0x67, 0x53])
const MP3_ID3 = file([0x49, 0x44, 0x33])
const MP3_SYNC = file([0xff, 0xfb])
const WEBP = riff('WEBP')
const WAV = riff('WAVE')

function mp4(size = 64): Buffer {
  const buffer = Buffer.alloc(size)
  buffer.write('ftyp', 4, 'ascii')
  return buffer
}

describe('format sniffing', () => {
  it('recognises every accepted format and types it correctly', () => {
    const cases: Array<[string, Buffer, string, string]> = [
      ['jpeg', JPEG, 'image', 'jpg'],
      ['png', PNG, 'image', 'png'],
      ['webp', WEBP, 'image', 'webp'],
      ['pdf', PDF, 'pdf', 'pdf'],
      ['wav', WAV, 'audio', 'wav'],
      ['ogg', OGG, 'audio', 'ogg'],
      ['mp3 con ID3', MP3_ID3, 'audio', 'mp3'],
      ['mp3 sin tag', MP3_SYNC, 'audio', 'mp3'],
      ['mp4', mp4(), 'video', 'mp4'],
    ]
    for (const [label, buffer, type, ext] of cases) {
      const r = validateMedia(buffer)
      expect(r.ok, label).toBe(true)
      if (r.ok) {
        expect(r.data.type, label).toBe(type)
        expect(r.data.ext, label).toBe(ext)
      }
    }
  })

  it('tells webp and wav apart even though both are RIFF', () => {
    // Same first four bytes. Reading only the container would type a sound file
    // as a photo and send it to WhatsApp as an image.
    const webp = validateMedia(WEBP)
    const wav = validateMedia(WAV)
    expect(webp.ok && webp.data.type).toBe('image')
    expect(wav.ok && wav.data.type).toBe('audio')
  })

  it('does not let the loose mp3 frame sync swallow another format', () => {
    // 0xFF-then-high-bits is only two bytes, so it is checked last. A JPEG also
    // opens with 0xFF and must not come out as audio.
    const r = validateMedia(JPEG)
    expect(r.ok && r.data.type).toBe('image')
  })

  it('refuses a format that is not on the list', () => {
    // "MZ": a Windows executable, the exact thing a bucket that trusts filenames
    // ends up serving over a presigned URL.
    const r = validateMedia(file([0x4d, 0x5a]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('media_unsupported_type')
  })

  it('refuses an empty file', () => {
    const r = validateMedia(Buffer.alloc(0))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('media_empty')
  })
})

describe('per-type ceilings', () => {
  it('accepts a PDF that would have been too large under the old single 5MB limit', () => {
    // The regression this fixes: one ceiling for everything rejected perfectly
    // ordinary price lists.
    const r = validateMedia(file([0x25, 0x50, 0x44, 0x46, 0x2d], 7 * 1024 * 1024))
    expect(r.ok).toBe(true)
  })

  it('still refuses an image of that size', () => {
    const r = validateMedia(file([0xff, 0xd8, 0xff], 7 * 1024 * 1024))
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.code).toBe('media_too_large')
      // The message has to name the limit for THAT type, or the owner cannot
      // tell why a file smaller than the one that worked was refused.
      expect(r.error.userMessage).toContain('5MB')
    }
  })

  it('judges size only after the format, since the ceiling depends on it', () => {
    // A 7MB buffer that matches no signature is a format problem, not a size
    // one — answering "too large" would send the owner off to shrink a file
    // that was never going to be accepted.
    const r = validateMedia(file([0x4d, 0x5a], 7 * 1024 * 1024))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('media_unsupported_type')
  })

  it('refuses a video over its own, larger ceiling', () => {
    const r = validateMedia(mp4(MAX_BYTES_BY_TYPE.video + 1))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.code).toBe('media_too_large')
  })

  it('exposes a global maximum that is the largest of the per-type ones', () => {
    // Used to refuse an oversized upload BEFORE buffering it, so it must never
    // be lower than a type that is actually allowed.
    expect(MAX_MEDIA_BYTES).toBe(Math.max(...Object.values(MAX_BYTES_BY_TYPE)))
    expect(MAX_MEDIA_BYTES).toBe(MAX_BYTES_BY_TYPE.video)
  })
})
