import { db } from '@/db/client.js'
import { knowledgeBase, messages, type Conversation, type Customer } from '@/db/schema/index.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import * as llmService from '@/modules/llm/llm.service.js'
import { AppError, NotFoundError } from '@/shared/errors.js'
import { afterAll, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeDb,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'

// Hoisted: vi.mock is lifted to the top of the file by Vitest, so any vars
// the mock factory references must come from vi.hoisted().
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }))

vi.mock('@/modules/llm/openai.client.js', () => ({
  openai: {
    chat: {
      completions: {
        create: mockCreate,
      },
    },
  },
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
  })

  afterAll(async () => {
    await closeDb()
  })

  it('builds the messages array with system + filtered history + last user msg', async () => {
    await db.insert(messages).values([
      { conversationId: conversationA.id, businessId: seed.businessA.id, role: 'user', content: 'Hola' },
      {
        conversationId: conversationA.id,
        businessId: seed.businessA.id,
        role: 'assistant',
        content: '¡Hola! ¿En qué te ayudo?',
      },
      {
        conversationId: conversationA.id,
        businessId: seed.businessA.id,
        role: 'user',
        content: '¿cuánto sale un corte?',
      },
    ])

    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'El corte sale S/30.' } }],
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

    expect(mockCreate).toHaveBeenCalledTimes(1)
    const callArgs = mockCreate.mock.calls[0]?.[0]
    assert(callArgs)
    expect(callArgs.model).toBe('gpt-4o-mini')
    expect(callArgs.temperature).toBe(0.4)
    expect(callArgs.max_tokens).toBe(300)

    const chatMessages = callArgs.messages
    // system + 3 history rows (all user/assistant) = 4
    expect(chatMessages).toHaveLength(4)
    expect(chatMessages[0].role).toBe('system')
    expect(chatMessages[0].content).toContain('Barbería A')
    expect(chatMessages[0].content).toContain('Corte: S/30')
    expect(chatMessages[1]).toEqual({ role: 'user', content: 'Hola' })
    expect(chatMessages[2]).toEqual({ role: 'assistant', content: '¡Hola! ¿En qué te ayudo?' })
    expect(chatMessages[3]).toEqual({ role: 'user', content: '¿cuánto sale un corte?' })
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
    expect(mockCreate).toHaveBeenCalledTimes(1)
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
})
