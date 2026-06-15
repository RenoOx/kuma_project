import { logger } from '@/config/logger.js'
import type { Message } from '@/db/schema/index.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as businessService from '@/modules/business/business.service.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as knowledgeBaseService from '@/modules/knowledgeBase/knowledgeBase.service.js'
import * as messageService from '@/modules/message/message.service.js'
import { AppError, NotConfiguredError, NotFoundError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions.js'
import type { ExecutedToolCall, GenerateReplyParams, LLMResponse } from './llm.types.js'
import { openai } from './openai.client.js'
import { buildSystemPrompt } from './prompts.js'
import { executeTool, type ToolContext } from './toolExecutor.js'
import { kumaTools } from './tools.js'

const MODEL = 'gpt-4o-mini'
const TEMPERATURE = 0.4
const MAX_TOKENS = 300
const HISTORY_LIMIT = 10
const MAX_TOOL_ITERATIONS = 5
const MAX_ITERATIONS_FALLBACK_TEXT =
  'Disculpa, no pude resolver tu consulta. Un humano te va a contactar.'

function convertHistoryToChatMessages(history: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []
  for (const msg of history) {
    if (msg.role === 'system') continue
    if (msg.role === 'tool') {
      if (!msg.toolCallId) continue
      out.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      })
      continue
    }
    if (msg.role === 'assistant') {
      // toolCalls is stored as the raw OpenAI shape per the Día 7 decision.
      const stored = msg.toolCalls as ChatCompletionMessageToolCall[] | null | undefined
      if (stored && stored.length > 0) {
        out.push({
          role: 'assistant',
          content: msg.content === '' ? null : msg.content,
          tool_calls: stored,
        })
      } else {
        out.push({ role: 'assistant', content: msg.content })
      }
      continue
    }
    if (msg.role === 'user') {
      out.push({ role: 'user', content: msg.content })
    }
  }
  return out
}

export async function generateReply(
  params: GenerateReplyParams,
): Promise<Result<LLMResponse>> {
  const log = logger.child({
    component: 'llm.service',
    businessId: params.businessId,
    conversationId: params.conversationId,
  })

  // 1. Business
  const businessResult = await businessService.getById(params.businessId)
  if (!businessResult.ok) return businessResult
  const business = businessResult.data

  // 2. Settings — NotConfiguredError is NOT fatal here; we pass `null` to the
  // prompt builder, which switches in the "no configuration" guidance for the
  // model. Any OTHER error (DB / unexpected) is fatal and we propagate.
  const settingsResult = await businessService.getSettings(params.businessId)
  let settings: BusinessSettings | null
  if (settingsResult.ok) {
    settings = settingsResult.data
  } else if (settingsResult.error instanceof NotConfiguredError) {
    settings = null
  } else {
    return settingsResult
  }

  // 3. Conversation (needed for customerId in tool context)
  const conversation = await conversationRepo.findById(params.businessId, params.conversationId)
  if (!conversation) {
    return err(
      new NotFoundError({
        resource: 'conversation',
        logContext: {
          businessId: params.businessId,
          conversationId: params.conversationId,
        },
      }),
    )
  }

  // 4. Knowledge base
  const kbResult = await knowledgeBaseService.getByBusiness(params.businessId)
  if (!kbResult.ok) return kbResult

  // 5. Recent history (handler is expected to have appended the user msg
  // already; we don't re-append).
  const historyResult = await messageService.getRecentHistory(
    params.businessId,
    params.conversationId,
    HISTORY_LIMIT,
  )
  if (!historyResult.ok) return historyResult

  const toolContext: ToolContext = {
    businessId: params.businessId,
    conversationId: params.conversationId,
    customerId: conversation.customerId,
  }

  const systemPrompt = buildSystemPrompt(business, kbResult.data, settings)
  const chatMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...convertHistoryToChatMessages(historyResult.data),
  ]

  let totalTokensInput = 0
  let totalTokensOutput = 0
  const executedTools: ExecutedToolCall[] = []
  let escalated = false

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let completion
    try {
      completion = await openai.chat.completions.create({
        model: MODEL,
        messages: chatMessages,
        tools: kumaTools,
        tool_choice: 'auto',
        temperature: TEMPERATURE,
        max_tokens: MAX_TOKENS,
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
            iteration,
            model: MODEL,
          },
          cause,
        }),
      )
    }

    totalTokensInput += completion.usage?.prompt_tokens ?? 0
    totalTokensOutput += completion.usage?.completion_tokens ?? 0

    const choice = completion.choices[0]
    const choiceMessage = choice?.message
    if (!choiceMessage) {
      return err(
        new AppError({
          code: 'llm_empty_response',
          message: 'openai returned no message in choice',
          userMessage: 'Disculpa, no pude generar una respuesta.',
          logContext: {
            businessId: params.businessId,
            conversationId: params.conversationId,
            iteration,
          },
        }),
      )
    }

    const toolCalls = choiceMessage.tool_calls
    const assistantContent = choiceMessage.content ?? ''

    // Final answer: model decided not to call any tools.
    if (!toolCalls || toolCalls.length === 0) {
      if (!assistantContent) {
        return err(
          new AppError({
            code: 'llm_empty_response',
            message: 'openai returned no content and no tool_calls',
            userMessage: 'Disculpa, no pude generar una respuesta.',
            logContext: {
              businessId: params.businessId,
              conversationId: params.conversationId,
              iteration,
            },
          }),
        )
      }

      const persistResult = await messageService.append({
        businessId: params.businessId,
        conversationId: params.conversationId,
        role: 'assistant',
        content: assistantContent,
      })
      if (!persistResult.ok) return persistResult

      log.info(
        {
          iteration,
          tokensInput: totalTokensInput,
          tokensOutput: totalTokensOutput,
          toolsExecuted: executedTools.length,
        },
        'llm produced final reply',
      )

      return ok({
        content: assistantContent,
        tokensInput: totalTokensInput,
        tokensOutput: totalTokensOutput,
        toolCallsExecuted: executedTools,
        escalated,
        maxIterationsHit: false,
      })
    }

    // Model wants to call tools. Persist the assistant turn (with raw OpenAI
    // tool_calls shape per Día 7 decision) and feed the same shape back to
    // the next iteration.
    const persistAssistant = await messageService.append({
      businessId: params.businessId,
      conversationId: params.conversationId,
      role: 'assistant',
      content: assistantContent,
      toolCalls: toolCalls,
    })
    if (!persistAssistant.ok) return persistAssistant

    chatMessages.push({
      role: 'assistant',
      content: assistantContent === '' ? null : assistantContent,
      tool_calls: toolCalls,
    })

    for (const call of toolCalls) {
      if (call.type !== 'function') continue

      let parsedArgs: unknown
      try {
        parsedArgs = JSON.parse(call.function.arguments)
      } catch {
        parsedArgs = {}
      }

      const toolResult = await executeTool(call.function.name, parsedArgs, toolContext)

      log.info(
        {
          iteration,
          tool: call.function.name,
          args: parsedArgs,
          resultPreview: toolResult.result.slice(0, 200),
          error: toolResult.error,
        },
        'tool executed',
      )

      executedTools.push({
        name: call.function.name,
        args: parsedArgs,
        result: toolResult.result,
        error: toolResult.error,
      })

      if (call.function.name === 'escalate_to_human' && !toolResult.error) {
        escalated = true
      }

      const persistTool = await messageService.append({
        businessId: params.businessId,
        conversationId: params.conversationId,
        role: 'tool',
        content: toolResult.result,
        toolCallId: call.id,
      })
      if (!persistTool.ok) return persistTool

      chatMessages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: toolResult.result,
      })
    }
  }

  // Safety net: too many iterations. Auto-escalate and return a canned reply.
  log.warn(
    {
      maxIterations: MAX_TOOL_ITERATIONS,
      toolsExecuted: executedTools.length,
    },
    'llm hit max tool iterations, auto-escalating',
  )

  if (!escalated) {
    const autoEscalate = await appointmentService.escalate({
      businessId: params.businessId,
      conversationId: params.conversationId,
      reason: 'llm max iterations exceeded',
    })
    if (autoEscalate.ok) escalated = true
  }

  const persistFallback = await messageService.append({
    businessId: params.businessId,
    conversationId: params.conversationId,
    role: 'assistant',
    content: MAX_ITERATIONS_FALLBACK_TEXT,
  })
  if (!persistFallback.ok) return persistFallback

  return ok({
    content: MAX_ITERATIONS_FALLBACK_TEXT,
    tokensInput: totalTokensInput,
    tokensOutput: totalTokensOutput,
    toolCallsExecuted: executedTools,
    escalated,
    maxIterationsHit: true,
  })
}
