import { logger } from '@/config/logger.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as customerService from '@/modules/customer/customer.service.js'
import * as llmService from '@/modules/llm/llm.service.js'
import * as messageService from '@/modules/message/message.service.js'
import type { WAMessage } from '@whiskeysockets/baileys'

const LLM_FALLBACK_REPLY = 'Disculpa, estoy con un problema técnico. Intentá de nuevo en un ratito.'

export type SendFn = (jid: string, text: string) => Promise<void>

// Returns the user-visible text of a Baileys message, or null if the message
// has no plain text payload we can answer to (media, reactions, status, etc.).
function extractText(msg: WAMessage): string | null {
  const message = msg.message
  if (!message) return null
  if (message.conversation) return message.conversation
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text
  return null
}

// Returns the peer's E.164 phone (without leading '+') from a Baileys JID
// like '51999111222@s.whatsapp.net'. Null for unsupported JID shapes.
function extractPhone(jid: string | null | undefined): string | null {
  if (!jid) return null
  const at = jid.indexOf('@')
  if (at < 0) return null
  const left = jid.slice(0, at)
  // Baileys phone JIDs are digits-only; group/status JIDs use other formats.
  if (!/^\d+$/.test(left)) return null
  return `+${left}`
}

export async function handleIncomingMessage(
  raw: WAMessage,
  businessId: string,
  send: SendFn,
): Promise<void> {
  const log = logger.child({ component: 'whatsapp.handler', businessId })

  // Skip our own echoes, group chats, status broadcasts, and empty payloads.
  if (raw.key.fromMe) return
  const jid = raw.key.remoteJid
  if (!jid) return
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') return

  const phone = extractPhone(jid)
  if (!phone) {
    log.debug({ jid }, 'skipping message with non-phone JID')
    return
  }

  const text = extractText(raw)
  if (!text) {
    log.debug({ jid }, 'skipping message with no text payload')
    return
  }

  const customerResult = await customerService.getOrCreate(
    businessId,
    phone,
    raw.pushName ?? undefined,
  )
  if (!customerResult.ok) {
    log.error({ err: customerResult.error.logContext, code: customerResult.error.code }, 'getOrCreate customer failed')
    return
  }
  const customer = customerResult.data

  const conversationResult = await conversationService.getOrCreateOpen(businessId, customer.id)
  if (!conversationResult.ok) {
    log.error(
      { err: conversationResult.error.logContext, code: conversationResult.error.code },
      'getOrCreateOpen conversation failed',
    )
    return
  }
  const conversation = conversationResult.data

  const userMsgResult = await messageService.append({
    businessId,
    conversationId: conversation.id,
    role: 'user',
    content: text,
  })
  if (!userMsgResult.ok) {
    log.error(
      { err: userMsgResult.error.logContext, code: userMsgResult.error.code },
      'append user message failed',
    )
    return
  }

  // Ask the LLM. generateReply now owns persistence of the assistant turn
  // (and any intermediate tool messages) because the tool-call loop produces
  // multiple rows that only the LLM service knows about.
  const llmResult = await llmService.generateReply({
    businessId,
    conversationId: conversation.id,
    userMessage: text,
  })

  let replyText: string
  if (llmResult.ok) {
    replyText = llmResult.data.content
    log.info(
      {
        conversationId: conversation.id,
        tokensInput: llmResult.data.tokensInput,
        tokensOutput: llmResult.data.tokensOutput,
        toolsExecuted: llmResult.data.toolCallsExecuted.map((t) => t.name),
        escalated: llmResult.data.escalated,
        maxIterationsHit: llmResult.data.maxIterationsHit,
      },
      'llm reply generated',
    )
  } else {
    replyText = LLM_FALLBACK_REPLY
    log.error(
      { code: llmResult.error.code, context: llmResult.error.logContext },
      'llm generateReply failed, using fallback message',
    )
    // On llm error the assistant turn was NOT persisted by the service, so
    // we persist the fallback ourselves to keep the chat history consistent.
    const fallbackPersist = await messageService.append({
      businessId,
      conversationId: conversation.id,
      role: 'assistant',
      content: replyText,
    })
    if (!fallbackPersist.ok) {
      log.error(
        { err: fallbackPersist.error.logContext, code: fallbackPersist.error.code },
        'append fallback assistant message failed',
      )
    }
  }

  try {
    await send(jid, replyText)
  } catch (err) {
    log.error({ err, jid }, 'failed to send reply over whatsapp')
  }
}
