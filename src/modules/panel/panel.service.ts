import { logger } from '@/config/logger.js'
import type { Business, PaymentVerificationStatus } from '@/db/schema/index.js'
import * as paymentVerificationRepo from '@/modules/appointment/paymentVerification.repo.js'
import type { OperatingHours } from '@/modules/business/business.settings.js'
import { parseBusinessSettings } from '@/modules/business/business.settings.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import { getPresignedUrl } from '@/modules/media/media.service.js'
import * as messageService from '@/modules/message/message.service.js'
import { notifyCustomer } from '@/modules/whatsapp/customerNotifier.js'
import { AppError, NotFoundError, ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as panelRepo from './panel.repo.js'

// How long a thread stays with the human before Emma takes it back on her own.
// PANEL_SPEC US-05. Read by the transitions worker, defined here because this
// is where takeover starts.
export const HUMAN_TAKEOVER_TIMEOUT_MS = 30 * 60 * 1000

export interface OwnerReplyResult {
  messageId: string
}

/**
 * The owner answering a customer from the panel.
 *
 * Order matters and is deliberate: WhatsApp first, database second. If the send
 * fails there is nothing to record — a bubble in the panel showing a message
 * the customer never got is worse than an error the owner can retry, because
 * the owner would stop waiting for a reply that is not coming.
 *
 * The send goes through notifyCustomer, which is already the one path from this
 * codebase to a customer's phone: it resolves the post-LID JID, refuses numbers
 * WhatsApp has flagged as dead, and queues through sendQueue at 'reply'
 * priority. Nothing here talks to Baileys directly.
 */
export async function sendOwnerReply(
  businessId: string,
  conversationId: string,
  text: string,
): Promise<Result<OwnerReplyResult>> {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return err(
      new ValidationError({
        code: 'empty_reply',
        message: 'panel reply had no content',
        userMessage: 'El mensaje está vacío.',
        logContext: { businessId, conversationId },
      }),
    )
  }

  const conversation = await panelRepo.findConversation(businessId, conversationId)
  if (!conversation) {
    return err(
      new NotFoundError({ resource: 'conversation', logContext: { businessId, conversationId } }),
    )
  }
  // An owner_thread has no customer to answer, and neither does a row whose
  // customer was deleted. Either way there is no phone on the other end.
  if (!conversation.customerId) {
    return err(
      new ValidationError({
        code: 'not_a_customer_thread',
        message: 'conversation has no customer to reply to',
        userMessage: 'Esta conversación no tiene un cliente al que responder.',
        logContext: { businessId, conversationId },
      }),
    )
  }

  const customer = await customerRepo.findById(businessId, conversation.customerId)
  if (!customer) {
    return err(
      new NotFoundError({
        resource: 'customer',
        logContext: { businessId, conversationId, customerId: conversation.customerId },
      }),
    )
  }

  const sent = await notifyCustomer(businessId, customer.phone, trimmed)
  if (!sent.ok) return sent

  const persisted = await messageService.append({
    businessId,
    conversationId,
    // 'assistant' in the model's vocabulary, 'human' in the panel's. The owner's
    // words have to replay as an assistant turn or Emma loses the thread when
    // she takes it back — see messages.senderType.
    role: 'assistant',
    content: trimmed,
    senderType: 'human',
  })
  if (!persisted.ok) {
    // The customer HAS the message; only our record of it failed. Reporting an
    // error here would invite the owner to send it twice.
    logger.error(
      { businessId, conversationId, code: persisted.error.code },
      'panel reply delivered but not persisted',
    )
  }

  await conversationRepo.setHumanTakeover(businessId, conversationId, new Date())

  logger.info({ businessId, conversationId }, 'owner replied from panel, takeover started')
  return ok({ messageId: persisted.ok ? persisted.data.id : '' })
}

/**
 * Hands the thread back to Emma (US-11).
 *
 * Clears the takeover clock and nothing else. In particular it does NOT switch
 * `emmaEnabled` back on: handing back a thread you were holding and undoing a
 * deliberate "Emma stays out of this chat" are two different decisions, and
 * only the owner makes the second one.
 */
export async function returnToEmma(
  businessId: string,
  conversationId: string,
): Promise<Result<void>> {
  const conversation = await panelRepo.findConversation(businessId, conversationId)
  if (!conversation) {
    return err(
      new NotFoundError({ resource: 'conversation', logContext: { businessId, conversationId } }),
    )
  }

  try {
    await conversationRepo.setHumanTakeover(businessId, conversationId, null)
    logger.info({ businessId, conversationId }, 'conversation returned to Emma from panel')
    return ok(undefined)
  } catch (cause) {
    return err(
      new AppError({
        code: 'return_to_emma_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos devolver la conversación a Emma.',
        logContext: { businessId, conversationId },
        cause,
      }),
    )
  }
}

// ── Payment proofs ───────────────────────────────────────────────────────────

export interface PaymentProofView {
  id: string
  service: string
  scheduledAt: string
  depositAmount: string | null
  customerName: string
  status: PaymentVerificationStatus
  createdAt: string
  resolvedAt: string | null
  rejectionReason: string | null
  /** Presigned and short-lived. Null when nothing was archived, or when signing failed. */
  proofUrl: string | null
}

/**
 * The deposit captures a conversation produced, for the chat to show inline.
 *
 * Until now the capture only ever existed as bytes passing through to the owner's
 * WhatsApp, so the panel could not show what the owner had ruled on. Rows without
 * a `proofKey` are still listed: a verification from before this existed, or one
 * whose upload failed, is still a decision the owner made and needs to see.
 *
 * A failure to sign degrades to `proofUrl: null` rather than failing the request —
 * the history is worth more than the thumbnail.
 */
export async function listPaymentProofs(
  businessId: string,
  conversationId: string,
): Promise<Result<PaymentProofView[]>> {
  try {
    const rows = await paymentVerificationRepo.listByConversation(businessId, conversationId)

    return ok(
      await Promise.all(
        rows.map(async (row) => {
          let proofUrl: string | null = null
          if (row.proofKey) {
            const signed = await getPresignedUrl(businessId, row.proofKey)
            if (signed.ok) proofUrl = signed.data
            else {
              logger.warn(
                { businessId, conversationId, verificationId: row.id, code: signed.error.code },
                'could not sign a payment proof for the panel',
              )
            }
          }

          return {
            id: row.id,
            service: row.service,
            scheduledAt: row.scheduledAt.toISOString(),
            depositAmount: row.depositAmount,
            customerName: row.customerName,
            status: row.status,
            createdAt: row.createdAt.toISOString(),
            resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
            rejectionReason: row.rejectionReason,
            proofUrl,
          }
        }),
      ),
    )
  } catch (cause) {
    return err(
      new AppError({
        code: 'list_payment_proofs_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos leer los comprobantes de esta conversación.',
        logContext: { businessId, conversationId },
        cause,
      }),
    )
  }
}

// ── Stats windows ────────────────────────────────────────────────────────────

export type StatsPeriod = 'today' | 'week' | 'month'

export interface StatsWindow {
  from: Date
  to: Date
  /** Start of the equally-sized window immediately before `from`. */
  prevFrom: Date
}

/**
 * Turns a period into two comparable windows.
 *
 * The previous window is the same length ending where the current one starts,
 * so "+12% vs la semana pasada" compares seven days with seven days rather than
 * a full week against however much of this one has elapsed.
 *
 * Computed in the server's local time, which on Railway is UTC. For a Lima
 * business that shifts the day boundary by five hours — acceptable for a trend
 * indicator, and the honest fix is a timezone-aware window, not a hardcoded
 * offset. Flagged rather than hidden.
 */
export function statsWindow(period: StatsPeriod, now: Date = new Date()): StatsWindow {
  const to = new Date(now)
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)

  if (period === 'week') from.setDate(from.getDate() - 6)
  if (period === 'month') from.setDate(from.getDate() - 29)

  const spanMs = Math.max(to.getTime() - from.getTime(), 1)
  return { from, to, prevFrom: new Date(from.getTime() - spanMs) }
}

/** Niche drives the panel's copy (Pacientes vs Clientes). */
export function nicheOf(business: Business): string {
  const settings = business.settings
  if (settings && typeof settings === 'object' && 'niche' in settings) {
    const niche = (settings as { niche?: unknown }).niche
    if (typeof niche === 'string') return niche
  }
  return 'general'
}

/**
 * The business's weekly hours, for the calendar to shade non-working time.
 *
 * Returns null rather than a default when the business has no settings yet: the
 * panel then shows a calendar with no shading at all, which is honest. Inventing
 * "lunes a sábado 8am-6pm" would draw a work week this business never agreed to,
 * and the owner has no way to tell an invented schedule from a configured one.
 */
export function operatingHoursOf(business: Business): OperatingHours | null {
  const settings = parseBusinessSettings(business.id, business.settings)
  return settings.ok ? settings.data.operatingHours : null
}
