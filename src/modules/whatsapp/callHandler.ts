import { logger } from '@/config/logger.js'
import * as businessService from '@/modules/business/business.service.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as customerService from '@/modules/customer/customer.service.js'
import * as eventsRepo from '@/modules/events/events.repo.js'
import * as messageService from '@/modules/message/message.service.js'
import type { IncomingCall } from './baileys.client.js'
import { pickCallRejectedReply } from './messageKind.js'

export interface CallDeps {
  rejectCall: (callId: string, callFrom: string) => Promise<void>
  send: (jid: string, text: string) => Promise<void>
}

// WhatsApp can re-offer the same call id after a network blip. Replying twice
// to one call attempt looks broken, so ids are remembered briefly.
const CALL_DEDUPE_TTL_MS = 5 * 60 * 1000
const handledCalls = new Map<string, number>()

function alreadyHandled(callId: string): boolean {
  const now = Date.now()
  for (const [id, at] of handledCalls) {
    if (now - at > CALL_DEDUPE_TTL_MS) handledCalls.delete(id)
  }
  if (handledCalls.has(callId)) return true
  handledCalls.set(callId, now)
  return false
}

function jidToPhone(jid: string): string | null {
  const left = jid.slice(0, jid.indexOf('@'))
  if (!/^\d+$/.test(left)) return null
  return `+${left}`
}

/**
 * Rejects an incoming WhatsApp call and follows up in writing.
 *
 * Rejecting rather than letting it ring out is deliberate: the caller learns
 * immediately that nobody is picking up, instead of waiting ~30s for a bot that
 * was never going to answer.
 */
export async function handleIncomingCall(
  call: IncomingCall,
  businessId: string,
  deps: CallDeps,
): Promise<void> {
  const log = logger.child({ component: 'whatsapp.callHandler', businessId })

  if (alreadyHandled(call.id)) {
    log.info({ callId: call.id }, 'call already handled, skipping duplicate offer')
    return
  }

  // Hang up first — the caller is waiting while we do everything else.
  try {
    await deps.rejectCall(call.id, call.from)
    log.info({ callId: call.id, from: call.from }, 'incoming call rejected')
  } catch (err) {
    log.error({ err, callId: call.id }, 'failed to reject incoming call')
  }

  const phone = jidToPhone(call.from)
  if (!phone) {
    log.warn({ from: call.from }, 'call from unsupported JID shape, no follow-up sent')
    return
  }

  const businessResult = await businessService.getById(businessId)
  if (!businessResult.ok) {
    log.error({ code: businessResult.error.code }, 'business not found for incoming call')
    return
  }
  const business = businessResult.data

  // The owner calling their own bot doesn't need a sales line back.
  const isOwner = business.ownerWhatsappNumber === phone

  const customerResult = await customerService.getOrCreate(businessId, phone)
  if (!customerResult.ok) {
    log.error({ code: customerResult.error.code }, 'getOrCreate customer failed for call')
    return
  }
  const conversationResult = await conversationService.getOrCreateOpen(
    businessId,
    customerResult.data.id,
  )
  const conversationId = conversationResult.ok ? conversationResult.data.id : null

  try {
    await eventsRepo.create({
      businessId,
      conversationId,
      type: 'missed_call',
      payload: { phone, isVideo: call.isVideo, isOwner },
    })
  } catch (err) {
    log.error({ err }, 'failed to record missed_call event')
  }

  if (isOwner) {
    log.info({ phone }, 'call came from the owner; rejected without a follow-up message')
    return
  }

  const paused = await businessService.isBotPaused(businessId)
  if (paused) {
    log.info({ phone }, 'bot paused; call rejected without a follow-up message')
    return
  }

  const reply = pickCallRejectedReply()
  if (conversationId) {
    const persisted = await messageService.append({
      businessId,
      conversationId,
      role: 'assistant',
      content: reply,
    })
    if (!persisted.ok) {
      log.error({ code: persisted.error.code }, 'append call follow-up message failed')
    }
  }

  try {
    await deps.send(call.from, reply)
    log.info({ phone }, 'post-call follow-up sent')
  } catch (err) {
    log.error({ err, phone }, 'failed to send post-call follow-up')
  }
}
