import { logger } from '@/config/logger.js'
import type { Appointment } from '@/db/schema/index.js'
import * as appointmentRepo from '@/modules/appointment/appointment.repo.js'
import * as businessService from '@/modules/business/business.service.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { buildReminder24hText, buildReminder2hText } from './reminderTexts.js'

export interface ReminderRunResult {
  sent24h: number
  sent2h: number
  errors: number
}

const HOUR_MS = 60 * 60 * 1000

// Builds the Baileys JID for a customer phone in E.164 format.
function customerJidFromPhone(phone: string): string {
  return `${phone.replace('+', '')}@s.whatsapp.net`
}

// Dispatches a single reminder for one appointment. Returns true iff the
// send succeeded; on any failure (business gone, no client, sendMessage
// throws, etc.) we log and return false so the caller can count the error.
async function dispatchReminder(
  appt: Appointment,
  kind: '24h' | '2h',
): Promise<boolean> {
  const log = logger.child({
    worker: 'sendReminders',
    appointmentId: appt.id,
    businessId: appt.businessId,
    kind,
  })

  const businessResult = await businessService.getById(appt.businessId)
  if (!businessResult.ok) {
    log.warn({ code: businessResult.error.code }, 'reminder skipped: business not found')
    return false
  }
  const business = businessResult.data

  const customer = await customerRepo.findById(appt.businessId, appt.customerId)
  if (!customer) {
    log.warn('reminder skipped: customer not found')
    return false
  }

  const client = clientRegistry.getClient(appt.businessId)
  if (!client) {
    log.warn('reminder skipped: no whatsapp client registered for this business')
    return false
  }

  const jid = customerJidFromPhone(customer.phone)
  const text =
    kind === '24h'
      ? buildReminder24hText(customer, business, appt)
      : buildReminder2hText(customer, business, appt)

  try {
    await client.sendMessage(jid, text)
    log.info({ jid, textPreview: text.slice(0, 60) }, 'reminder sent')
    return true
  } catch (err) {
    log.error({ err, jid }, 'reminder sendMessage threw')
    return false
  }
}

// Cross-tenant batch run. Called on a setInterval from server.ts.
// TODO V1.5: migrar a BullMQ scheduled jobs cuando incorporemos Redis.
export async function sendDueReminders(): Promise<ReminderRunResult> {
  const now = Date.now()

  // Spec windows:
  //   24h reminder → scheduledAt ∈ [now+23h, now+25h)
  //   2h  reminder → scheduledAt ∈ [now+1.5h, now+2.5h)
  const due24h = await appointmentRepo.findDueForReminder(
    '24h',
    new Date(now + 23 * HOUR_MS),
    new Date(now + 25 * HOUR_MS),
  )
  const due2h = await appointmentRepo.findDueForReminder(
    '2h',
    new Date(now + 1.5 * HOUR_MS),
    new Date(now + 2.5 * HOUR_MS),
  )

  let sent24h = 0
  let sent2h = 0
  let errors = 0

  for (const appt of due24h) {
    const sent = await dispatchReminder(appt, '24h')
    if (sent) {
      try {
        await appointmentRepo.markReminderSent(appt.businessId, appt.id, '24h')
        sent24h++
      } catch (err) {
        logger.error(
          { err, appointmentId: appt.id },
          'markReminderSent 24h failed after successful send',
        )
        errors++
      }
    } else {
      errors++
    }
  }

  for (const appt of due2h) {
    const sent = await dispatchReminder(appt, '2h')
    if (sent) {
      try {
        await appointmentRepo.markReminderSent(appt.businessId, appt.id, '2h')
        sent2h++
      } catch (err) {
        logger.error(
          { err, appointmentId: appt.id },
          'markReminderSent 2h failed after successful send',
        )
        errors++
      }
    } else {
      errors++
    }
  }

  const result = { sent24h, sent2h, errors }
  if (sent24h > 0 || sent2h > 0 || errors > 0) {
    logger.info(result, 'sendDueReminders run complete')
  }
  return result
}
