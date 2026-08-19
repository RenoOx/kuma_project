import { logger } from '@/config/logger.js'
import { AppError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as clientRegistry from './clientRegistry.js'

// Mirror of ownerNotifier, pointed the other way: the business pushing a message
// to one of its customers. Used when the owner acts on a booking request from
// their own WhatsApp and the patient has to be told the outcome.
//
// KNOWN LIMITATION: builds the classic `<digits>@s.whatsapp.net` JID. Customers
// whose phone was derived from a LID (see extractPhone in handler.ts) have no
// such JID and the send fails — same gap the reminders worker has.
function customerJidFromPhone(phone: string): string {
  return `${phone.replace('+', '')}@s.whatsapp.net`
}

/**
 * Sends a proactive message to a customer over WhatsApp.
 *
 * A missing WA client returns err rather than ok: unlike notifyOwner, the caller
 * here has just told the owner "listo, le avisé al paciente", so silently
 * swallowing a failed delivery would make Emma lie about something the owner is
 * relying on.
 */
export async function notifyCustomer(
  businessId: string,
  phone: string,
  text: string,
): Promise<Result<void>> {
  const client = clientRegistry.getClient(businessId)
  if (!client) {
    return err(
      new AppError({
        code: 'whatsapp_client_unavailable',
        message: `no whatsapp client registered for business ${businessId}`,
        userMessage: 'No pude enviarle el mensaje al paciente: WhatsApp no está conectado.',
        logContext: { businessId },
      }),
    )
  }

  const jid = customerJidFromPhone(phone)
  try {
    await client.sendMessage(jid, text)
    logger.info({ businessId, jid, textPreview: text.slice(0, 60) }, 'notified customer')
    return ok(undefined)
  } catch (cause) {
    return err(
      new AppError({
        code: 'notify_customer_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude enviarle el mensaje al paciente por WhatsApp.',
        logContext: { businessId, jid },
        cause,
      }),
    )
  }
}
