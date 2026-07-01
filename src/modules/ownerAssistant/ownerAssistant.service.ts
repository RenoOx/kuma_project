import { logger } from '@/config/logger.js'
import type { Message } from '@/db/schema/index.js'
import * as businessService from '@/modules/business/business.service.js'
import { openai } from '@/modules/llm/openai.client.js'
import * as messageRepo from '@/modules/message/message.repo.js'
import * as messageService from '@/modules/message/message.service.js'
import { AppError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions.js'
import { buildOwnerSystemPrompt } from './ownerAssistant.prompts.js'
import { executeOwnerTool } from './ownerAssistant.toolExecutor.js'
import { ownerTools } from './ownerAssistant.tools.js'
import type { OwnerContext, OwnerReply } from './ownerAssistant.types.js'

const MODEL = 'gpt-4o-mini'
const TEMPERATURE = 0.3
const MAX_TOKENS = 400
const HISTORY_LIMIT = 10
const MAX_TOOL_ITERATIONS = 5
const OPENAI_TIMEOUT_MS = 30_000
const FALLBACK_TEXT = 'Disculpá, no pude procesar esa consulta. Probá de nuevo.'

function todayInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

function dayOfWeekInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-PE', {
      timeZone: timezone,
      weekday: 'long',
    }).format(new Date())
  } catch {
    return ''
  }
}

function convertHistory(history: Message[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = []
  for (const m of history) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      if (!m.toolCallId) continue
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
      continue
    }
    if (m.role === 'assistant') {
      const stored = m.toolCalls as ChatCompletionMessageToolCall[] | null | undefined
      if (stored && stored.length > 0) {
        out.push({
          role: 'assistant',
          content: m.content === '' ? null : m.content,
          tool_calls: stored,
        })
      } else {
        out.push({ role: 'assistant', content: m.content })
      }
      continue
    }
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
    }
  }
  return out
}

export async function handle(
  businessId: string,
  conversationId: string,
  userText: string,
): Promise<Result<OwnerReply>> {
  const log = logger.child({
    component: 'ownerAssistant.service',
    businessId,
    conversationId,
  })

  const businessResult = await businessService.getById(businessId)
  if (!businessResult.ok) return businessResult
  const business = businessResult.data

  // 1. Persist the owner's incoming message FIRST so the history we read
  // below already includes it (same contract as llm.service).
  const userPersist = await messageService.append({
    businessId,
    conversationId,
    role: 'user',
    content: userText,
  })
  if (!userPersist.ok) return userPersist

  const history = await messageRepo.findRecentByConversation(
    businessId,
    conversationId,
    HISTORY_LIMIT,
  )

  const ctx: OwnerContext = {
    businessId,
    conversationId,
    ownerName: business.ownerName ?? 'jefe',
    currentDate: todayInTimezone(business.timezone),
    currentDayOfWeek: dayOfWeekInTimezone(business.timezone),
    businessTimezone: business.timezone,
  }

  const chatMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildOwnerSystemPrompt(ctx) },
    ...convertHistory(history),
  ]

  let totalTokensInput = 0
  let totalTokensOutput = 0
  const toolsExecuted: string[] = []

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    let completion
    try {
      completion = await openai.chat.completions.create(
        {
          model: MODEL,
          messages: chatMessages,
          tools: ownerTools,
          tool_choice: 'auto',
          temperature: TEMPERATURE,
          max_tokens: MAX_TOKENS,
        },
        { signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS) },
      )
    } catch (cause) {
      const isTimeout =
        cause instanceof Error &&
        (cause.name === 'TimeoutError' || cause.name === 'AbortError')
      return err(
        new AppError({
          code: isTimeout ? 'owner_assistant_timeout' : 'owner_assistant_failed',
          message: cause instanceof Error ? cause.message : 'unknown error',
          userMessage: 'Tuve un problema con el modelo, probá de nuevo.',
          logContext: { businessId, conversationId, iteration, model: MODEL, timedOut: isTimeout },
          cause,
        }),
      )
    }

    totalTokensInput += completion.usage?.prompt_tokens ?? 0
    totalTokensOutput += completion.usage?.completion_tokens ?? 0

    const choice = completion.choices[0]?.message
    if (!choice) {
      return err(
        new AppError({
          code: 'owner_assistant_empty_response',
          message: 'openai returned no message in choice',
          userMessage: 'No tuve respuesta del modelo. Probá de nuevo.',
          logContext: { businessId, conversationId, iteration },
        }),
      )
    }

    const toolCalls = choice.tool_calls
    const assistantContent = choice.content ?? ''

    if (!toolCalls || toolCalls.length === 0) {
      if (!assistantContent) {
        return err(
          new AppError({
            code: 'owner_assistant_empty_response',
            message: 'openai returned no content and no tool_calls',
            userMessage: 'No tuve respuesta. Probá de nuevo.',
            logContext: { businessId, conversationId, iteration },
          }),
        )
      }
      const persist = await messageService.append({
        businessId,
        conversationId,
        role: 'assistant',
        content: assistantContent,
      })
      if (!persist.ok) return persist

      log.info(
        {
          iteration,
          tokensInput: totalTokensInput,
          tokensOutput: totalTokensOutput,
          toolsExecuted,
        },
        'owner reply produced',
      )

      return ok({
        content: assistantContent,
        tokensInput: totalTokensInput,
        tokensOutput: totalTokensOutput,
        toolsExecuted,
        maxIterationsHit: false,
      })
    }

    const persistAssistant = await messageService.append({
      businessId,
      conversationId,
      role: 'assistant',
      content: assistantContent,
      toolCalls,
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

      const toolResult = await executeOwnerTool(call.function.name, parsedArgs, ctx)
      log.info(
        {
          iteration,
          tool: call.function.name,
          args: parsedArgs,
          resultPreview: toolResult.result.slice(0, 200),
          error: toolResult.error,
        },
        'owner tool executed',
      )
      toolsExecuted.push(call.function.name)

      const persistTool = await messageService.append({
        businessId,
        conversationId,
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

  log.warn(
    { maxIterations: MAX_TOOL_ITERATIONS, toolsExecuted },
    'owner assistant hit max tool iterations, falling back',
  )

  const fallbackPersist = await messageService.append({
    businessId,
    conversationId,
    role: 'assistant',
    content: FALLBACK_TEXT,
  })
  if (!fallbackPersist.ok) return fallbackPersist

  return ok({
    content: FALLBACK_TEXT,
    tokensInput: totalTokensInput,
    tokensOutput: totalTokensOutput,
    toolsExecuted,
    maxIterationsHit: true,
  })
}
