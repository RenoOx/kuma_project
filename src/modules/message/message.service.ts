import { db } from '@/db/client.js'
import type { Message, MessageRole } from '@/db/schema/index.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import { AppError, NotFoundError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as messageRepo from './message.repo.js'

export interface AppendParams {
  businessId: string
  conversationId: string
  role: MessageRole
  content: string
  toolCalls?: unknown
  toolCallId?: string
}

export async function append(params: AppendParams): Promise<Result<Message>> {
  try {
    const message = await db.transaction(async (tx) => {
      const created = await messageRepo.create(
        {
          businessId: params.businessId,
          conversationId: params.conversationId,
          role: params.role,
          content: params.content,
          toolCalls: params.toolCalls ?? null,
          toolCallId: params.toolCallId ?? null,
        },
        tx,
      )
      await conversationRepo.updateLastMessageAt(
        params.businessId,
        params.conversationId,
        created.createdAt,
        tx,
      )
      return created
    })
    return ok(message)
  } catch (cause) {
    // Postgres FK violations on bad conversationId/businessId surface here
    // and the surrounding transaction rolls back automatically.
    return err(
      new AppError({
        code: 'message_append_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos guardar tu mensaje.',
        logContext: {
          businessId: params.businessId,
          conversationId: params.conversationId,
          role: params.role,
        },
        cause,
      }),
    )
  }
}

export async function getRecentHistory(
  businessId: string,
  conversationId: string,
  limit = 15,
): Promise<Result<Message[]>> {
  try {
    const conversation = await conversationRepo.findById(businessId, conversationId)
    if (!conversation) {
      return err(
        new NotFoundError({
          resource: 'conversation',
          logContext: { businessId, conversationId },
        }),
      )
    }
    const history = await messageRepo.findRecentByConversation(businessId, conversationId, limit)
    return ok(history)
  } catch (cause) {
    return err(
      new AppError({
        code: 'message_history_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos cargar el historial.',
        logContext: { businessId, conversationId },
        cause,
      }),
    )
  }
}
