import { logger } from '@/config/logger.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as messageService from '@/modules/message/message.service.js'

/**
 * Records a message Emma pushed to the owner into their `owner_thread`.
 *
 * Proactive pushes used to be socket sends and nothing else, so the owner saw a
 * continuous WhatsApp thread while the assistant read one with all of its own
 * notifications missing. Asked "dile que no se ve bien el pago" right after a
 * payment card, the model had no phone in context and went back to the owner
 * for one it had just sent them.
 *
 * Stored as `assistant` because that is literally who emitted it: `convertHistory`
 * maps that role straight through, whereas `system` rows are dropped.
 *
 * Never throws and never reports failure: the message has already left by the
 * time this runs, so a lost transcript row must not turn a delivered
 * notification into a caller-visible error.
 */
export async function recordOwnerNotification(businessId: string, text: string): Promise<void> {
  const thread = await conversationService.findOrCreateOwnerThread(businessId)
  if (!thread.ok) {
    logger.warn(
      { businessId, code: thread.error.code },
      'owner notification sent but no owner thread to record it in',
    )
    return
  }

  const persisted = await messageService.append({
    businessId,
    conversationId: thread.data.id,
    role: 'assistant',
    content: text,
  })
  if (!persisted.ok) {
    logger.warn(
      { businessId, conversationId: thread.data.id, code: persisted.error.code },
      'owner notification sent but could not be recorded in the owner thread',
    )
  }
}
