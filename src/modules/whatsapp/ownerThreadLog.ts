import { logger } from '@/config/logger.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as eventsRepo from '@/modules/events/events.repo.js'
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
/** El tipo de evento que el panel muestra dentro del chat del cliente. */
export const OWNER_NOTIFIED_EVENT = 'owner_notified'

/**
 * Deja en el chat del CLIENTE la copia exacta de lo que se le avisó al dueño.
 *
 * El hilo del dueño (`recordOwnerNotification`) es para el asistente del dueño,
 * y el Inbox no lo lista. Sin esto, desde el panel no había forma de saber qué
 * le llegó al dueño sobre un cliente, ni cuándo (pedido de Renzo, 2026-11-09).
 * Va como evento y no como mensaje: un mensaje entraría al historial que lee
 * Emma, y el aviso no es algo que se le dijo al cliente.
 *
 * Nunca falla hacia afuera, por la misma razón que `recordOwnerNotification`.
 */
export async function recordOwnerNoticeInChat(
  businessId: string,
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    await eventsRepo.create({
      businessId,
      conversationId,
      type: OWNER_NOTIFIED_EVENT,
      payload: { text },
    })
  } catch (err) {
    logger.warn(
      { err, businessId, conversationId },
      'owner notice sent but not recorded in the chat',
    )
  }
}

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
