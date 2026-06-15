import { db } from '@/db/client.js'
import {
  conversations,
  knowledgeBase,
  messages,
  type Conversation,
  type Customer,
} from '@/db/schema/index.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import * as llmService from '@/modules/llm/llm.service.js'
import { AppError, NotFoundError } from '@/shared/errors.js'
import { asc, eq } from 'drizzle-orm'
import { afterAll, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeDb,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'

// Hoisted: vi.mock is lifted to the top of the file by Vitest, so any vars
// the mock factory references must come from vi.hoisted().
const { mockCreate, mockExecuteTool } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockExecuteTool: vi.fn(),
}))

vi.mock('@/modules/llm/openai.client.js', () => ({
  openai: {
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  },
}))

vi.mock('@/modules/llm/toolExecutor.js', () => ({
  executeTool: mockExecuteTool,
}))

describe('llm.service.generateReply', () => {
  let seed: TwoBusinessesSeed
  let customerA: Customer
  let conversationA: Conversation

  beforeEach(async () => {
    await resetDb()
    seed = await seedTwoBusinesses()
    customerA = await customerRepo.create({
      businessId: seed.businessA.id,
      phone: '+51900001000',
      name: 'Cliente Test',
    })
    conversationA = await conversationRepo.create({
      businessId: seed.businessA.id,
      customerId: customerA.id,
    })
    await db.insert(knowledgeBase).values([
      { businessId: seed.businessA.id, category: 'services', content: 'Corte de cabello' },
      { businessId: seed.businessA.id, category: 'pricing', content: 'Corte: S/30' },
    ])
    mockCreate.mockReset()
    mockExecuteTool.mockReset()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('returns a plain text reply when the model does not call tools, and persists it', async () => {
    await db.insert(messages).values({
      conversationId: conversationA.id,
      businessId: seed.businessA.id,
      role: 'user',
      content: '¿cuánto sale un corte?',
    })

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'El corte sale S/30.', tool_calls: undefined } }],
      usage: { prompt_tokens: 120, completion_tokens: 18 },
    })

    const result = await llmService.generateReply({
      businessId: seed.businessA.id,
      conversationId: conversationA.id,
      userMessage: '¿cuánto sale un corte?',
    })

    assert(result.ok)
    expect(result.data.content).toBe('El corte sale S/30.')
    expect(result.data.tokensInput).toBe(120)
    expect(result.data.tokensOutput).toBe(18)
    expect(result.data.toolCallsExecuted).toEqual([])
    expect(result.data.escalated).toBe(false)
    expect(result.data.maxIterationsHit).toBe(false)

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const callArgs = mockCreate.mock.calls[0]?.[0]
    assert(callArgs)
    expect(callArgs.model).toBe('gpt-4o-mini')
    expect(callArgs.tools).toBeDefined()
    expect(callArgs.tools.length).toBe(3)
    expect(callArgs.tool_choice).toBe('auto')

    // Assistant message was persisted by the service.
    const stored = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationA.id))
      .orderBy(asc(messages.createdAt))
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(stored[1]?.content).toBe('El corte sale S/30.')
    expect(stored[1]?.toolCalls).toBeNull()
  })

  it('executes a tool call, persists tool messages, and feeds the result back to a second iteration', async () => {
    await db.insert(messages).values({
      conversationId: conversationA.id,
      businessId: seed.businessA.id,
      role: 'user',
      content: '¿qué horarios tienen mañana?',
    })

    // First completion: model wants to call check_availability.
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_abc',
                type: 'function',
                function: {
                  name: 'check_availability',
                  arguments: JSON.stringify({ date_iso: '2026-06-16', service: 'corte' }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 30 },
    })

    mockExecuteTool.mockResolvedValueOnce({
      result: JSON.stringify({ availableSlots: ['2026-06-16T10:00:00-05:00'] }),
    })

    // Second completion: model produces the final natural-language reply.
    mockCreate.mockResolvedValueOnce({
      choices: [
        { message: { content: 'Tengo disponible mañana a las 10am.', tool_calls: undefined } },
      ],
      usage: { prompt_tokens: 150, completion_tokens: 22 },
    })

    const result = await llmService.generateReply({
      businessId: seed.businessA.id,
      conversationId: conversationA.id,
      userMessage: '¿qué horarios tienen mañana?',
    })

    assert(result.ok)
    expect(result.data.content).toBe('Tengo disponible mañana a las 10am.')
    expect(result.data.toolCallsExecuted).toHaveLength(1)
    expect(result.data.toolCallsExecuted[0]?.name).toBe('check_availability')
    expect(result.data.toolCallsExecuted[0]?.args).toEqual({
      date_iso: '2026-06-16',
      service: 'corte',
    })
    expect(result.data.tokensInput).toBe(80 + 150)
    expect(result.data.tokensOutput).toBe(30 + 22)
    expect(result.data.escalated).toBe(false)

    expect(mockCreate).toHaveBeenCalledTimes(2)
    expect(mockExecuteTool).toHaveBeenCalledTimes(1)
    expect(mockExecuteTool).toHaveBeenCalledWith(
      'check_availability',
      { date_iso: '2026-06-16', service: 'corte' },
      expect.objectContaining({
        businessId: seed.businessA.id,
        conversationId: conversationA.id,
        customerId: customerA.id,
      }),
    )

    // DB now has: user + assistant(with tool_calls) + tool + assistant(final).
    const stored = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationA.id))
      .orderBy(asc(messages.createdAt))
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    expect(stored[1]?.toolCalls).not.toBeNull()
    expect(stored[2]?.toolCallId).toBe('call_abc')
    expect(stored[3]?.content).toBe('Tengo disponible mañana a las 10am.')
  })

  it('flags escalated=true when the model invokes escalate_to_human successfully', async () => {
    await db.insert(messages).values({
      conversationId: conversationA.id,
      businessId: seed.businessA.id,
      role: 'user',
      content: 'quiero hablar con una persona',
    })

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_esc',
                type: 'function',
                function: {
                  name: 'escalate_to_human',
                  arguments: JSON.stringify({ reason: 'cliente pidió humano' }),
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 60, completion_tokens: 10 },
    })

    mockExecuteTool.mockResolvedValueOnce({
      result: JSON.stringify({ status: 'escalated', reason: 'cliente pidió humano' }),
    })

    mockCreate.mockResolvedValueOnce({
      choices: [
        { message: { content: 'Le aviso al dueño, ya te contactan.', tool_calls: undefined } },
      ],
      usage: { prompt_tokens: 90, completion_tokens: 12 },
    })

    const result = await llmService.generateReply({
      businessId: seed.businessA.id,
      conversationId: conversationA.id,
      userMessage: 'quiero hablar con una persona',
    })

    assert(result.ok)
    expect(result.data.escalated).toBe(true)
    expect(result.data.toolCallsExecuted[0]?.name).toBe('escalate_to_human')
  })

  it('returns AppError when openai throws', async () => {
    await db.insert(messages).values({
      conversationId: conversationA.id,
      businessId: seed.businessA.id,
      role: 'user',
      content: 'Hola',
    })

    mockCreate.mockRejectedValueOnce(new Error('openai is down'))

    const result = await llmService.generateReply({
      businessId: seed.businessA.id,
      conversationId: conversationA.id,
      userMessage: 'Hola',
    })

    assert(!result.ok)
    expect(result.error).toBeInstanceOf(AppError)
    expect(result.error.code).toBe('llm_generate_failed')

    // On error path the assistant message must NOT be persisted (handler does
    // that for the fallback).
    const stored = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, conversationA.id))
    expect(stored.map((m) => m.role)).toEqual(['user'])
  })

  it('returns NotFoundError when the business does not exist (does not hit openai)', async () => {
    const result = await llmService.generateReply({
      businessId: 'nonexistent_business_id',
      conversationId: conversationA.id,
      userMessage: 'Hola',
    })

    assert(!result.ok)
    expect(result.error).toBeInstanceOf(NotFoundError)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('returns NotFoundError when the conversation does not exist', async () => {
    const result = await llmService.generateReply({
      businessId: seed.businessA.id,
      conversationId: 'nonexistent_conversation_id',
      userMessage: 'Hola',
    })

    assert(!result.ok)
    expect(result.error).toBeInstanceOf(NotFoundError)
    expect(mockCreate).not.toHaveBeenCalled()
  })

  it('hits max iterations safety net, auto-escalates, and returns the fallback message', async () => {
    await db.insert(messages).values({
      conversationId: conversationA.id,
      businessId: seed.businessA.id,
      role: 'user',
      content: 'algo',
    })

    // Every iteration the model asks for a tool call, never returns plain text.
    for (let i = 0; i < 5; i++) {
      mockCreate.mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: `call_${i}`,
                  type: 'function',
                  function: {
                    name: 'check_availability',
                    arguments: JSON.stringify({ date_iso: '2026-06-16', service: 'corte' }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 50, completion_tokens: 5 },
      })
      mockExecuteTool.mockResolvedValueOnce({
        result: JSON.stringify({ availableSlots: [] }),
      })
    }

    const result = await llmService.generateReply({
      businessId: seed.businessA.id,
      conversationId: conversationA.id,
      userMessage: 'algo',
    })

    assert(result.ok)
    expect(result.data.maxIterationsHit).toBe(true)
    expect(result.data.escalated).toBe(true)
    expect(result.data.content).toContain('humano')
    expect(mockCreate).toHaveBeenCalledTimes(5)
    expect(mockExecuteTool).toHaveBeenCalledTimes(5)

    // Conversation should now be 'escalated'.
    const [conv] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationA.id))
    expect(conv?.status).toBe('escalated')
  })
})
