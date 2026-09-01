import { logger } from '@/config/logger.js'
import * as businessService from '@/modules/business/business.service.js'
import { AppError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as clientRegistry from './clientRegistry.js'
import { recordOwnerNotification } from './ownerThreadLog.js'

// Builds the Baileys JID for a phone number stored in E.164 (+51999...).
// Baileys uses `<digits>@s.whatsapp.net` for individual chats.
function ownerJidFromPhone(phone: string): string {
  return `${phone.replace('+', '')}@s.whatsapp.net`
}

export interface NotifyOwnerOptions {
  /**
   * Whether the push is written into the owner thread so the assistant can
   * refer back to it. Defaults to true.
   *
   * Only `send_daily_report_now` sets this false: it fires from inside the
   * assistant's own tool loop, so a row written here would land between the
   * assistant turn holding the tool_calls and its tool result. OpenAI rejects
   * that ordering on the next turn and the whole owner flow breaks. The report
   * reaches the transcript through the tool result anyway.
   */
  recordInOwnerThread?: boolean
}

// Sends a proactive message to the business owner via WhatsApp.
// Soft-fail cases (owner not configured / WA client not registered) return
// ok(undefined) because they are recoverable states the caller doesn't need
// to react to. Hard failures (sendMessage throws) return err and are logged.
export async function notifyOwner(
  businessId: string,
  text: string,
  opts: NotifyOwnerOptions = {},
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
    logger.info({ businessId, jid, textPreview: text.slice(0, 60) }, 'notified owner')
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

  // Awaited rather than fired off: the owner can reply within seconds, and a row
  // that lands after their answer would sit below it in the transcript — the
  // model would read the reply before the notification that prompted it.
  if (opts.recordInOwnerThread !== false) {
    await recordOwnerNotification(businessId, text)
  }

  return ok(undefined)
}
