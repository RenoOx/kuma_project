import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { humanDelay } from '@/shared/humanDelay.js'

// Lives here rather than in handler.ts so the owner assistant can reach it. The
// owner's reply_to_customer tool sends to a customer just like the handler
// does, and importing handler.ts from the owner tool executor would close a
// cycle: handler → ownerAssistant.service → ownerAssistant.toolExecutor.

export type SendFn = (jid: string, text: string) => Promise<void>

// How long the "typing…" indicator stays up before the text lands. Stacks on
// top of humanDelay, so the customer perceives 3–4.5s total.
const COMPOSING_HOLD_MS = 1500

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
 */
export async function sendWithPresence(params: {
  businessId: string
  jid: string
  text: string
  send: SendFn
}): Promise<void> {
  const { businessId, jid, text, send } = params

  await humanDelay()

  const sock = clientRegistry.getClient(businessId)?.sock
  try {
    await sock?.sendPresenceUpdate('composing', jid)
    await new Promise((resolve) => setTimeout(resolve, COMPOSING_HOLD_MS))
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
}
