import { logger } from '@/config/logger.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import { AppError } from '@/shared/errors.js'
import { preview } from '@/shared/logRedact.js'
import { normalizePhone } from '@/shared/phone.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as clientRegistry from './clientRegistry.js'
import { customerJid } from './customerJid.js'
import { enqueueSend } from './sendQueue.js'

// Mirror of ownerNotifier, pointed the other way: the business pushing a message
// to one of its customers. Used when the owner acts on a booking request from
// their own WhatsApp and the patient has to be told the outcome.

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

  // Looked up rather than derived: the row carries the JID WhatsApp routes by,
  // which for a post-LID contact is nothing the phone can reconstruct.
  const customer = await customerRepo.findByPhone(businessId, normalizePhone(phone) ?? phone)
  if (!customer) {
    return err(
      new AppError({
        code: 'customer_not_found',
        message: `no customer with phone ${phone} in business ${businessId}`,
        userMessage: 'No encontré a ese paciente en este negocio, así que no le escribí.',
        logContext: { businessId },
      }),
    )
  }

  // WhatsApp already told us this JID has nobody behind it. Saying so is worth
  // more to the owner than a send that will fail — and retrying a dead number
  // is exactly the pattern that gets a number flagged.
  if (customer.whatsappUnreachableAt) {
    return err(
      new AppError({
        code: 'customer_unreachable',
        message: `customer ${customer.id} flagged unreachable at ${customer.whatsappUnreachableAt.toISOString()}`,
        userMessage:
          'Ese número ya no tiene WhatsApp activo, así que no le pude escribir. Habría que contactarlo por otra vía.',
        logContext: { businessId, customerId: customer.id },
      }),
    )
  }

  const jid = customerJid(customer)
  try {
    // 'reply' priority, not 'reminder': the owner has just been told the patient
    // was messaged and is watching for it to land.
    await enqueueSend(businessId, 'reply', () => client.sendMessage(jid, text))
    logger.info({ businessId, jid, textPreview: preview(text) }, 'notified customer')
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
