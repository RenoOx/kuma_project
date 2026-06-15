import { logger } from '@/config/logger.js'
import * as businessService from '@/modules/business/business.service.js'
import * as knowledgeBaseService from '@/modules/knowledgeBase/knowledgeBase.service.js'
import * as messageService from '@/modules/message/message.service.js'
import { AppError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js'
import type { GenerateReplyParams, LLMResponse } from './llm.types.js'
import { openai } from './openai.client.js'
import { buildSystemPrompt } from './prompts.js'

const MODEL = 'gpt-4o-mini'
const TEMPERATURE = 0.4
const MAX_TOKENS = 300
const HISTORY_LIMIT = 10

export async function generateReply(
  params: GenerateReplyParams,
): Promise<Result<LLMResponse>> {
  // 1. Business
  const businessResult = await businessService.getById(params.businessId)
  if (!businessResult.ok) return businessResult
  const business = businessResult.data

  // 2. Knowledge base
  const kbResult = await knowledgeBaseService.getByBusiness(params.businessId)
  if (!kbResult.ok) return kbResult
  const knowledgeBase = kbResult.data

  // 3. Recent history (the user message is expected to already be in here,
  // since the handler appends it before calling us — see check below).
  const historyResult = await messageService.getRecentHistory(
    params.businessId,
    params.conversationId,
    HISTORY_LIMIT,
  )
  if (!historyResult.ok) return historyResult
  const history = historyResult.data

  // 4. Build the messages array. We drop 'tool' / 'system' history rows
  // because today the LLM doesn't use tools — including them would confuse
  // gpt-4o-mini. The system prompt we build below replaces them.
  const systemPrompt = buildSystemPrompt(business, knowledgeBase)
  const chatMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...history
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
  ]

  // Defensive: the contract is that the handler stored the user message
  // before calling us, so it should be the last in history. If not, append
  // it explicitly so we don't silently ask the LLM the wrong question.
  const lastHistoryItem = history[history.length - 1]
  const lastIsThisUserMessage =
    lastHistoryItem?.role === 'user' && lastHistoryItem.content === params.userMessage
  if (!lastIsThisUserMessage) {
    logger.warn(
      {
        businessId: params.businessId,
        conversationId: params.conversationId,
        expectedUserMessage: params.userMessage,
      },
      'user message not last in history; appending defensively',
    )
    chatMessages.push({ role: 'user', content: params.userMessage })
  }

  // 5. Call OpenAI
  try {
    const completion = await openai.chat.completions.create({
      model: MODEL,
      messages: chatMessages,
      temperature: TEMPERATURE,
      max_tokens: MAX_TOKENS,
    })

    const choice = completion.choices[0]
    const content = choice?.message?.content
    if (!content) {
      return err(
        new AppError({
          code: 'llm_empty_response',
          message: 'openai returned no message content',
          userMessage: 'Disculpa, no pude generar una respuesta.',
          logContext: {
            businessId: params.businessId,
            conversationId: params.conversationId,
          },
        }),
      )
    }

    return ok({
      content,
      tokensInput: completion.usage?.prompt_tokens ?? 0,
      tokensOutput: completion.usage?.completion_tokens ?? 0,
    })
  } catch (cause) {
    return err(
      new AppError({
        code: 'llm_generate_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'Disculpa, estoy con un problema técnico.',
        logContext: {
          businessId: params.businessId,
          conversationId: params.conversationId,
          model: MODEL,
        },
        cause,
      }),
    )
  }
}
