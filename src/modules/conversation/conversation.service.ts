import { logger } from '@/config/logger.js'
import type { Conversation, ConversationStatus } from '@/db/schema/index.js'
import type { FlowType } from '@/modules/business/business.settings.js'
import { AppError, NotFoundError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as conversationRepo from './conversation.repo.js'
import { getNextState } from './stateMachine.js'

// How long an escalated thread still counts as "the conversation this customer
// is in". Past this, a new message is a new conversation.
const ESCALATED_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000

export async function getOrCreateOpen(
  businessId: string,
  customerId: string,
): Promise<Result<Conversation>> {
  try {
    const existing = await conversationRepo.findOpenByCustomer(businessId, customerId)
    if (existing) return ok(existing)

    // An escalation does not end the conversation — it flags that a human owes
    // it an answer. Only `open` used to match here, so the customer's next
    // message opened a blank thread: Emma greeted them as a first-timer and
    // dropped everything that had been said, including whatever made her
    // escalate. Reuse the escalated thread instead, leaving its status alone so
    // it stays visible as pending.
    const escalated = await conversationRepo.findRecentEscalatedByCustomer(
      businessId,
      customerId,
      new Date(Date.now() - ESCALATED_REUSE_WINDOW_MS),
    )
    if (escalated) {
      logger.info(
        {
          component: 'conversation.service',
          businessId,
          customerId,
          conversationId: escalated.id,
          lastMessageAt: escalated.lastMessageAt,
        },
        'reusing escalated conversation instead of starting a fresh one',
      )
      return ok(escalated)
    }

    const created = await conversationRepo.create({ businessId, customerId })
    return ok(created)
  } catch (cause) {
    return err(
      new AppError({
        code: 'conversation_get_or_create_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos abrir tu conversación.',
        logContext: { businessId, customerId },
        cause,
      }),
    )
  }
}

// One owner_thread per business. customerId stays null because the owner
// isn't a customer record; the rolling 48h memory lives in this conversation.
export async function findOrCreateOwnerThread(businessId: string): Promise<Result<Conversation>> {
  try {
    const existing = await conversationRepo.findOwnerThread(businessId)
    if (existing) return ok(existing)
    const created = await conversationRepo.create({
      businessId,
      customerId: null,
      type: 'owner_thread',
    })
    return ok(created)
  } catch (cause) {
    return err(
      new AppError({
        code: 'owner_thread_get_or_create_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos abrir tu hilo de asistente.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}

/**
 * Moves the conversation along the state machine and returns where it landed.
 *
 * This is the ONLY place in the codebase that writes conversation.state. The
 * pieces that observe what happened — the tool executor, the image handler —
 * name a trigger and hand it here; deciding where that leads belongs to
 * stateMachine, and persisting it belongs to this function.
 *
 * flowType and currentState come from the caller rather than being loaded here:
 * both callers already hold them, and a service that hides queries inside a
 * hot path is how a per-message read turns into three.
 */
export async function applyTrigger(params: {
  businessId: string
  conversationId: string
  flowType: FlowType
  currentState: string
  trigger: string
}): Promise<Result<string>> {
  const { businessId, conversationId, flowType, currentState, trigger } = params
  const nextState = getNextState(flowType, currentState, trigger)

  // The common case: the flow defines no transition for this trigger, so the
  // conversation stays where it is. No UPDATE for a write that changes nothing.
  if (nextState === currentState) return ok(currentState)

  try {
    await conversationRepo.updateState(businessId, conversationId, nextState)
    logger.info(
      {
        component: 'conversation.service',
        businessId,
        conversationId,
        flowType,
        trigger,
        from: currentState,
        to: nextState,
      },
      'conversation state transition applied',
    )
    return ok(nextState)
  } catch (cause) {
    return err(
      new AppError({
        code: 'conversation_apply_trigger_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        // Never reaches a customer: callers log this and carry on with the old
        // state rather than losing the reply over a bookkeeping write.
        userMessage: 'No pudimos actualizar tu conversación.',
        logContext: { businessId, conversationId, flowType, trigger, currentState, nextState },
        cause,
      }),
    )
  }
}

export async function close(businessId: string, conversationId: string): Promise<Result<void>> {
  return changeStatus(
    businessId,
    conversationId,
    'closed',
    'conversation_close_failed',
    'No pudimos cerrar tu conversación.',
  )
}

export async function escalate(businessId: string, conversationId: string): Promise<Result<void>> {
  return changeStatus(
    businessId,
    conversationId,
    'escalated',
    'conversation_escalate_failed',
    'No pudimos escalar tu conversación.',
  )
}

async function changeStatus(
  businessId: string,
  conversationId: string,
  status: ConversationStatus,
  errorCode: string,
  userMessage: string,
): Promise<Result<void>> {
  try {
    const found = await conversationRepo.findById(businessId, conversationId)
    if (!found) {
      return err(
        new NotFoundError({
          resource: 'conversation',
          logContext: { businessId, conversationId },
        }),
      )
    }
    await conversationRepo.updateStatus(businessId, conversationId, status)
    return ok(undefined)
  } catch (cause) {
    return err(
      new AppError({
        code: errorCode,
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage,
        logContext: { businessId, conversationId, status },
        cause,
      }),
    )
  }
}
