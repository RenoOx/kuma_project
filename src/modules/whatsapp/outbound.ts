import type { WAMessageKey, WASocket } from '@whiskeysockets/baileys'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { enqueueSend, type SendPriority } from '@/modules/whatsapp/sendQueue.js'
import { humanDelay, typingDelayMs } from '@/shared/humanDelay.js'

// Lives here rather than in handler.ts so the owner assistant can reach it. The
// owner's reply_to_customer tool sends to a customer just like the handler
// does, and importing handler.ts from the owner tool executor would close a
// cycle: handler → ownerAssistant.service → ownerAssistant.toolExecutor.

export type SendFn = (jid: string, text: string) => Promise<void>

// How long the message sits "seen but not yet opened" before the blue ticks go
// out. A person glances at a notification and then opens the chat; they do not
// do both in the same millisecond.
const READ_DELAY_MIN_MS = 500
const READ_DELAY_MAX_MS = 1500

/**
 * Marks the message being answered as read, before anything is typed.
 *
 * An account that answers everything and never reads anything is a telemetry
 * shape no real client produces — a human opens the chat, then replies. Failures
 * are swallowed for the same reason presence failures are: this is a signal
 * about us, never something the customer is waiting on.
 */
async function markRead(
  sock: WASocket | undefined,
  readKey: WAMessageKey | undefined,
): Promise<void> {
  if (!sock || !readKey) return
  try {
    const delay = READ_DELAY_MIN_MS + Math.random() * (READ_DELAY_MAX_MS - READ_DELAY_MIN_MS)
    await new Promise((resolve) => setTimeout(resolve, delay))
    await sock.readMessages([readKey])
  } catch {
    // Silent by contract.
  }
}

/**
 * Sends a CUSTOMER-facing message with human-looking timing.
 *
 * The socket is reached through the registry rather than passed in: `send` is a
 * bound `(jid, text)` closure with no presence capability, and `WhatsappClient`
 * exposes the raw `sock`. A missing client (not yet connected, or mid-reconnect)
 * degrades to no presence rather than blocking the message.
 *
 * Presence failures are swallowed on purpose — "typing…" is cosmetic, and losing
 * the actual reply over it would be a far worse bug than looking robotic.
 *
 * The ENTIRE sequence runs inside the send queue, not just the send: firing
 * "composing" before queuing would leave a typing indicator up for a message
 * still waiting its turn, which is a worse lie than no indicator at all.
 */
export async function sendWithPresence(params: {
  businessId: string
  jid: string
  text: string
  send: SendFn
  /** Key of the inbound message this answers, so Emma reads before she writes. */
  readKey?: WAMessageKey
}): Promise<void> {
  const { businessId, jid, text, send, readKey } = params

  return enqueueSend(businessId, 'reply', async () => {
    const sock = clientRegistry.getClient(businessId)?.sock

    // Read → think → type → answer, in that order.
    await markRead(sock, readKey)
    await humanDelay()

    try {
      await sock?.sendPresenceUpdate('composing', jid)
      // Proportional to what is about to be sent, not a flat hold.
      await new Promise((resolve) => setTimeout(resolve, typingDelayMs(text)))
    } catch {
      // Silent by contract: never block the message over a presence hiccup.
    }

    // Deliberately NOT wrapped: callers already handle send failures and log them.
    await send(jid, text)

    try {
      await sock?.sendPresenceUpdate('paused', jid)
    } catch {
      // Silent by contract.
    }
  })
}

/**
 * Queued send with no human timing.
 *
 * For traffic that is not a customer-facing reply — the owner poking their own
 * bot, the demo acknowledgement — where a fake 4.5s of typing buys nothing. It
 * still goes through the queue because WhatsApp counts these against the same
 * number as everything else.
 */
export async function sendDirect(params: {
  businessId: string
  jid: string
  text: string
  send: SendFn
  priority?: SendPriority
  /** Key of the inbound message this answers, when there is one. */
  readKey?: WAMessageKey
}): Promise<void> {
  const { businessId, jid, text, send, priority = 'owner', readKey } = params
  return enqueueSend(businessId, priority, async () => {
    await markRead(clientRegistry.getClient(businessId)?.sock, readKey)
    await send(jid, text)
  })
}
