import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetSentServiceImagesForTests,
  canSendServiceMedia,
  markServiceImageSent,
} from './sentServiceImages.js'

// The window is what decides whether a customer who asks twice gets an answer
// twice. It used to be one send with a six-hour memory, which in a chat that
// lasts minutes is "never again": a customer asked about the same course 71
// minutes after being shown its photo and got nothing at all.

const CONVERSATION = 'conv-1'
const SERVICE = 'svc-1'
const MINUTE = 60 * 1000

beforeEach(() => {
  _resetSentServiceImagesForTests()
})

describe('canSendServiceMedia', () => {
  it('allows two sends inside the window and refuses the third', () => {
    const t0 = 1_000_000

    expect(canSendServiceMedia(CONVERSATION, SERVICE, t0)).toBe(true)
    markServiceImageSent(CONVERSATION, SERVICE, t0)

    // The second ask is the one the old rule lost. It is also the common one:
    // the customer scrolled past the photo, or is comparing two services.
    expect(canSendServiceMedia(CONVERSATION, SERVICE, t0 + 5 * MINUTE)).toBe(true)
    markServiceImageSent(CONVERSATION, SERVICE, t0 + 5 * MINUTE)

    expect(canSendServiceMedia(CONVERSATION, SERVICE, t0 + 6 * MINUTE)).toBe(false)
  })

  it('lets the window slide instead of resetting it', () => {
    const t0 = 1_000_000
    markServiceImageSent(CONVERSATION, SERVICE, t0)
    markServiceImageSent(CONVERSATION, SERVICE, t0 + 10 * MINUTE)

    expect(canSendServiceMedia(CONVERSATION, SERVICE, t0 + 14 * MINUTE)).toBe(false)

    // 16 minutes in, the FIRST send has aged out and the second has not, so
    // there is room for exactly one more. A fixed reset would have given two.
    expect(canSendServiceMedia(CONVERSATION, SERVICE, t0 + 16 * MINUTE)).toBe(true)
    markServiceImageSent(CONVERSATION, SERVICE, t0 + 16 * MINUTE)
    expect(canSendServiceMedia(CONVERSATION, SERVICE, t0 + 16 * MINUTE)).toBe(false)
  })

  it('counts each service separately', () => {
    const t0 = 1_000_000
    markServiceImageSent(CONVERSATION, SERVICE, t0)
    markServiceImageSent(CONVERSATION, SERVICE, t0)

    expect(canSendServiceMedia(CONVERSATION, SERVICE, t0)).toBe(false)
    expect(canSendServiceMedia(CONVERSATION, 'svc-2', t0)).toBe(true)
  })

  it('counts each conversation separately', () => {
    // Two customers asking about the same course are two customers. Keying on
    // the service alone would have shown the photo to one of them only.
    const t0 = 1_000_000
    markServiceImageSent(CONVERSATION, SERVICE, t0)
    markServiceImageSent(CONVERSATION, SERVICE, t0)

    expect(canSendServiceMedia(CONVERSATION, SERVICE, t0)).toBe(false)
    expect(canSendServiceMedia('conv-2', SERVICE, t0)).toBe(true)
  })

  it('allows the first send of a pair it has never seen', () => {
    expect(canSendServiceMedia('nueva', 'nunca-vista')).toBe(true)
  })
})
