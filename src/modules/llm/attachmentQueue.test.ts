import { describe, expect, it } from 'vitest'
import { MAX_ATTACHMENTS_PER_TURN, queueAttachments } from './attachmentQueue.js'
import type { ToolAttachment } from './toolExecutor.js'

function file(key: string): ToolAttachment {
  return {
    s3Key: key,
    caption: 'Curso',
    serviceId: 'svc-1',
    type: 'image',
    mimetype: 'image/jpeg',
    filename: `${key}.jpg`,
  }
}

describe('queueAttachments', () => {
  it('caps the TURN, not the tool call', () => {
    // The bug this replaced: the cap was applied to one service's file list, so
    // three services with two files each came to six outbound WhatsApp messages
    // under a constant named PER_TURN. Every attachment is its own message.
    const queued: ToolAttachment[] = []
    queueAttachments(queued, [file('a'), file('b')])
    queueAttachments(queued, [file('c'), file('d')])
    queueAttachments(queued, [file('e')])

    expect(queued).toHaveLength(MAX_ATTACHMENTS_PER_TURN)
    expect(queued.map((a) => a.s3Key)).toEqual(['a', 'b'])
  })

  it('keeps the first ones offered, so display_order decides', () => {
    const queued: ToolAttachment[] = []
    queueAttachments(queued, [file('primera'), file('segunda'), file('tercera')])
    expect(queued.map((a) => a.s3Key)).toEqual(['primera', 'segunda'])
  })

  it('does not queue the same file twice across calls', () => {
    // The send registry is only written once the handler has actually sent, so a
    // model asking for the same photo in two iterations reaches here twice.
    const queued: ToolAttachment[] = []
    queueAttachments(queued, [file('a')])
    queueAttachments(queued, [file('a')])
    expect(queued).toHaveLength(1)
  })

  it('leaves the queue alone when a tool returned nothing', () => {
    const queued: ToolAttachment[] = [file('a')]
    queueAttachments(queued, [])
    expect(queued).toHaveLength(1)
  })
})
