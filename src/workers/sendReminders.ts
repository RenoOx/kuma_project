import { logger } from '@/config/logger.js'
import type { Appointment } from '@/db/schema/index.js'
import * as appointmentRepo from '@/modules/appointment/appointment.repo.js'
import * as businessService from '@/modules/business/business.service.js'
import { remindersExplicitlyDisabled } from '@/modules/business/business.settings.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { customerJid } from '@/modules/whatsapp/customerJid.js'
import { enqueueSend } from '@/modules/whatsapp/sendQueue.js'
import { preview } from '@/shared/logRedact.js'
import { appointmentName } from '@/shared/name.js'
import { withTimeout } from '@/shared/withTimeout.js'
import { buildReminder2hText, buildReminder24hText } from './reminderTexts.js'

export interface ReminderRunResult {
  sent24h: number
  sent2h: number
  errors: number
  /** Reminders deliberately not attempted: unreachable number, attempts spent. */
  skipped: number
}

/**
 * What one dispatch attempt concluded.
 *
 * - `sent`: it went out; mark the row.
 * - `unreachable`: WhatsApp says there is no account behind this JID. The
 *   CUSTOMER gets flagged, the appointment row does NOT get marked as reminded —
 *   nothing was sent and the data should not claim otherwise. Later polls stop
 *   at the flag before touching WhatsApp, and the window expires on its own.
 * - `retryable`: something transient (WhatsApp down, DB blip). Counts an
 *   attempt against the cap below.
 * - `disabled`: the business switched reminders off. Nothing was sent and
 *   nothing is wrong, so it is neither an error nor a retry — the row is left
 *   unmarked and the window simply expires.
 */
type DispatchOutcome = 'sent' | 'unreachable' | 'retryable' | 'disabled'

const HOUR_MS = 60 * 60 * 1000

// Reminders leave spaced out, not in a burst. Thirty of them in ten seconds is
// a broadcast — the one outbound pattern WhatsApp reads as spam on sight. The
// same thirty spread over minutes is a business working through its day.
export const REMINDER_GAP_MIN_MS = 10_000
export const REMINDER_GAP_MAX_MS = 30_000

// 25 x ~20s is roughly 8 minutes, comfortably inside the 15-minute poll.
// Whatever does not fit waits for the next run: the 24h window is an hour wide
// and the 2h window half an hour, so every appointment gets two to four shots.
export const MAX_REMINDERS_PER_RUN = 25

// The reachability query below runs inside a sequential run. On the socket's
// 3-minute default it could stall the entire reminder batch on one bad lookup,
// so it gets its own short leash — and a timeout simply means "send anyway",
// which is the same fallback a failed query already had.
const REACHABILITY_TIMEOUT_MS = 10_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function reminderGapMs(): number {
  return (
    REMINDER_GAP_MIN_MS + Math.floor(Math.random() * (REMINDER_GAP_MAX_MS - REMINDER_GAP_MIN_MS))
  )
}

// A reminder that keeps failing gets two shots, not one per poll. The 24h
// window is an hour wide, so without this an appointment whose number is alive
// but not accepting our messages was retried four times per window.
//
// In memory, like the dedup map and the notice cooldowns in handler.ts: a
// redeploy resets it and the cost is one extra attempt, which is cheaper than a
// column and a migration for state that only has to outlive an hour.
export const MAX_DISPATCH_ATTEMPTS = 2
const DISPATCH_ATTEMPT_TTL_MS = 6 * HOUR_MS
const dispatchAttempts = new Map<string, { count: number; at: number }>()

function attemptKey(appointmentId: string, kind: '24h' | '2h'): string {
  return `${appointmentId}:${kind}`
}

function attemptsSpent(appointmentId: string, kind: '24h' | '2h', now: number): number {
  const entry = dispatchAttempts.get(attemptKey(appointmentId, kind))
  if (!entry) return 0
  if (now - entry.at >= DISPATCH_ATTEMPT_TTL_MS) {
    dispatchAttempts.delete(attemptKey(appointmentId, kind))
    return 0
  }
  return entry.count
}

function recordAttempt(appointmentId: string, kind: '24h' | '2h', now: number): void {
  const key = attemptKey(appointmentId, kind)
  const entry = dispatchAttempts.get(key)
  const stale = entry !== undefined && now - entry.at >= DISPATCH_ATTEMPT_TTL_MS
  dispatchAttempts.set(key, { count: stale || !entry ? 1 : entry.count + 1, at: now })

  // Bounded cleanup: without it the map keeps every appointment this process
  // ever reminded.
  if (dispatchAttempts.size > 1000) {
    for (const [k, v] of dispatchAttempts) {
      if (now - v.at >= DISPATCH_ATTEMPT_TTL_MS) dispatchAttempts.delete(k)
    }
  }
}

// Dispatches a single reminder for one appointment. See DispatchOutcome for
// what each answer commits the caller to.
async function dispatchReminder(appt: Appointment, kind: '24h' | '2h'): Promise<DispatchOutcome> {
  const log = logger.child({
    worker: 'sendReminders',
    appointmentId: appt.id,
    businessId: appt.businessId,
    kind,
  })

  const businessResult = await businessService.getById(appt.businessId)
  if (!businessResult.ok) {
    log.warn({ code: businessResult.error.code }, 'reminder skipped: business not found')
    return 'retryable'
  }
  const business = businessResult.data

  // The owner's reminder switch (panel > Configuración > Reservas y avisos).
  // Checked here rather than in the query above so the decision sits next to
  // the send it prevents. Explicit opt-out only — see
  // remindersExplicitlyDisabled for why an unset value still sends.
  if (remindersExplicitlyDisabled(business.settings)) {
    log.info('reminder skipped: business turned automatic reminders off')
    return 'disabled'
  }

  const customer = await customerRepo.findById(appt.businessId, appt.customerId)
  if (!customer) {
    log.warn('reminder skipped: customer not found')
    return 'retryable'
  }

  // Short-circuits before any WhatsApp traffic. This is what turns "flagged
  // once" into "never messaged again until they write back" — the flag is
  // cleared by the next inbound message, so nobody is excluded permanently.
  if (customer.whatsappUnreachableAt) {
    log.info(
      { customerId: customer.id, since: customer.whatsappUnreachableAt },
      'reminder skipped: customer already flagged as not on whatsapp',
    )
    return 'unreachable'
  }

  const client = clientRegistry.getClient(appt.businessId)
  if (!client) {
    log.warn('reminder skipped: no whatsapp client registered for this business')
    return 'retryable'
  }

  const jid = customerJid(customer)

  // Ask WhatsApp whether this JID has an account before writing to it. The
  // number may have been abandoned between booking and the reminder, and a row
  // whose "phone" is really a LID rebuilds into a JID that never existed.
  //
  // Baileys skips "@lid" JIDs here and answers with an empty list, so the check
  // only bites on classic "<digits>@s.whatsapp.net" addresses. That is the right
  // split: a stored @lid came from a message the customer actually sent, while a
  // rebuilt @s.whatsapp.net for a LID row names an account that never existed —
  // and that is precisely the one this catches.
  //
  // A failed or empty query does NOT block the send: a flaky IQ must not silence
  // a whole business's reminders, and the worst case is the send we would have
  // made anyway.
  try {
    const [presence] =
      (await withTimeout(client.sock.onWhatsApp(jid), REACHABILITY_TIMEOUT_MS, 'onWhatsApp')) ?? []
    if (presence && presence.exists === false) {
      await customerRepo.markWhatsappUnreachable(appt.businessId, customer.id)
      log.warn({ jid, customerId: customer.id }, 'reminder skipped: jid has no whatsapp account')
      return 'unreachable'
    }
  } catch (err) {
    log.warn({ err, jid }, 'onWhatsApp check failed — sending anyway')
  }

  // Greeted by the name this appointment was booked under, not by whatever the
  // customer row says today: a patient who last booked for their daughter must
  // not get their own reminder addressed to her.
  const greeted = { name: appointmentName(appt, customer) }
  const text =
    kind === '24h'
      ? buildReminder24hText(greeted, business, appt)
      : buildReminder2hText(greeted, business, appt)

  try {
    // Lowest priority in the queue: a reminder has a whole window to land in,
    // a patient waiting on an answer does not.
    await enqueueSend(appt.businessId, 'reminder', () => client.sendMessage(jid, text))
    log.info({ jid, textPreview: preview(text) }, 'reminder sent')
    return 'sent'
  } catch (err) {
    log.error({ err, jid }, 'reminder sendMessage threw')
    return 'retryable'
  }
}

// Guards against overlapping runs. The spacing above can stretch a run past the
// 15-minute poll, and because a reminder is marked as sent only AFTER it goes
// out, a second run starting on top of the first would re-query rows the first
// has not marked yet and send them a second time.
let running = false

// Cross-tenant batch run. Called on a setInterval from server.ts.
// TODO V1.5: migrar a BullMQ scheduled jobs cuando incorporemos Redis.
export async function sendDueReminders(): Promise<ReminderRunResult> {
  if (running) {
    logger.warn('sendDueReminders still running from a previous tick — skipping this one')
    return { sent24h: 0, sent2h: 0, errors: 0, skipped: 0 }
  }
  running = true
  try {
    return await runDueReminders()
  } finally {
    running = false
  }
}

async function runDueReminders(): Promise<ReminderRunResult> {
  const now = Date.now()

  // Spec windows: ceiling is the exact target (never fire late), floor is a
  // grace period covering missed poll cycles (never fire more than that early).
  //   24h reminder → scheduledAt ∈ [now+23h, now+24h]
  //   2h  reminder → scheduledAt ∈ [now+1.5h, now+2h]
  const due24h = await appointmentRepo.findDueForReminder(
    '24h',
    new Date(now + 23 * HOUR_MS),
    new Date(now + 24 * HOUR_MS),
  )
  const due2h = await appointmentRepo.findDueForReminder(
    '2h',
    new Date(now + 1.5 * HOUR_MS),
    new Date(now + 2 * HOUR_MS),
  )

  // One flat list so the per-run budget and the spacing cover the whole run
  // rather than each bucket on its own. 2h reminders go first: their window is
  // only half an hour wide, so one deferred to the next run may miss it
  // entirely, while a 24h reminder has an hour of slack.
  const batch: Array<{ appt: Appointment; kind: '24h' | '2h' }> = [
    ...due2h.map((appt) => ({ appt, kind: '2h' as const })),
    ...due24h.map((appt) => ({ appt, kind: '24h' as const })),
  ]

  let sent24h = 0
  let sent2h = 0
  let errors = 0
  let skipped = 0

  // Filtered BEFORE the per-run cap so a batch of exhausted reminders cannot
  // starve the ones that still have a chance of going out.
  const eligible = batch.filter((item) => {
    if (attemptsSpent(item.appt.id, item.kind, now) < MAX_DISPATCH_ATTEMPTS) return true
    skipped++
    logger.warn(
      { appointmentId: item.appt.id, kind: item.kind, attempts: MAX_DISPATCH_ATTEMPTS },
      'reminder skipped: dispatch attempts exhausted, not retrying this window',
    )
    return false
  })

  const scheduled = eligible.slice(0, MAX_REMINDERS_PER_RUN)
  const deferred = eligible.length - scheduled.length

  for (const [index, item] of scheduled.entries()) {
    if (index > 0) await sleep(reminderGapMs())

    const outcome = await dispatchReminder(item.appt, item.kind)

    if (outcome === 'unreachable') {
      // Deliberately NOT marked as reminded: nothing was sent, and the row must
      // not claim it was. The customer flag is what stops the next poll.
      skipped++
      continue
    }

    if (outcome === 'retryable') {
      recordAttempt(item.appt.id, item.kind, Date.now())
      errors++
      continue
    }

    if (outcome === 'disabled') {
      // Not an error and not a retry: the business asked for no reminders. The
      // row stays unmarked so turning the switch back on inside the window
      // still lets this one go out.
      skipped++
      continue
    }

    try {
      await appointmentRepo.markReminderSent(item.appt.businessId, item.appt.id, item.kind)
      if (item.kind === '24h') sent24h++
      else sent2h++
    } catch (err) {
      logger.error(
        { err, appointmentId: item.appt.id, kind: item.kind },
        'markReminderSent failed after successful send',
      )
      errors++
    }
  }

  const result = { sent24h, sent2h, errors, skipped }
  if (sent24h > 0 || sent2h > 0 || errors > 0 || skipped > 0 || deferred > 0) {
    logger.info({ ...result, deferred }, 'sendDueReminders run complete')
  }
  return result
}
