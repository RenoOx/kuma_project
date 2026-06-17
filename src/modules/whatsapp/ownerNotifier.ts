import { logger } from '@/config/logger.js'
import * as businessService from '@/modules/business/business.service.js'
import { AppError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as clientRegistry from './clientRegistry.js'

// Builds the Baileys JID for a phone number stored in E.164 (+51999...).
// Baileys uses `<digits>@s.whatsapp.net` for individual chats.
function ownerJidFromPhone(phone: string): string {
  return `${phone.replace('+', '')}@s.whatsapp.net`
}

// Sends a proactive message to the business owner via WhatsApp.
// Soft-fail cases (owner not configured / WA client not registered) return
// ok(undefined) because they are recoverable states the caller doesn't need
// to react to. Hard failures (sendMessage throws) return err and are logged.
export async function notifyOwner(
  businessId: string,
  text: string,
): Promise<Result<void>> {
  const businessResult = await businessService.getById(businessId)
  if (!businessResult.ok) return businessResult
  const business = businessResult.data

  if (!business.ownerWhatsappNumber) {
    logger.debug(
      { businessId },
      'notifyOwner skipped: business has no ownerWhatsappNumber configured',
    )
    return ok(undefined)
  }

  const client = clientRegistry.getClient(businessId)
  if (!client) {
    logger.warn(
      { businessId },
      'notifyOwner skipped: no whatsapp client registered for this business',
    )
    return ok(undefined)
  }

  const jid = ownerJidFromPhone(business.ownerWhatsappNumber)
  try {
    await client.sendMessage(jid, text)
    logger.info(
      { businessId, jid, textPreview: text.slice(0, 60) },
      'notified owner',
    )
    return ok(undefined)
  } catch (cause) {
    return err(
      new AppError({
        code: 'notify_owner_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude notificar al dueño por WhatsApp.',
        logContext: { businessId, jid },
        cause,
      }),
    )
  }
}
