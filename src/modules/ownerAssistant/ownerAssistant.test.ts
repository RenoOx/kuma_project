import { db } from '@/db/client.js'
import {
  businesses,
  conversations,
  messages,
  type Conversation,
} from '@/db/schema/index.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as ownerAssistantService from '@/modules/ownerAssistant/ownerAssistant.service.js'
import { eq } from 'drizzle-orm'
import { afterAll, assert, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeDb,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../../tests/helpers/db.js'

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

async function setOwner(businessId: string, phone: string, name: string): Promise<void> {
  await db
    .update(businesses)
    .set({ ownerWhatsappNumber: phone, ownerName: name })
    .where(eq(businesses.id, businessId))
}

describe('ownerAssistant.service.handle', () => {
  let seed: TwoBusinessesSeed
  let ownerConvA: Conversation

  beforeEach(async () => {
    await resetDb()
    seed = await seedTwoBusinesses()
    await setOwner(seed.businessA.id, '+51999000111', 'TestOwner')

    const convResult = await conversationService.findOrCreateOwnerThread(seed.businessA.id)
    assert(convResult.ok)
    ownerConvA = convResult.data

    mockCreate.mockReset()
  })

  afterAll(async () => {
    await closeDb()
  })

  it('returns a plain reply with no tool calls for a general question', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Hola jefe, todo tranquilo por acá.', tool_calls: undefined } }],
      usage: { prompt_tokens: 70, completion_tokens: 12 },
    })

    const result = await ownerAssistantService.handle(seed.businessA.id, ownerConvA.id, 'hola')
    assert(result.ok)
    expect(result.data.content).toContain('jefe')
    expect(result.data.toolsExecuted).toEqual([])

    const callArgs = mockCreate.mock.calls[0]?.[0]
    assert(callArgs)
    expect(callArgs.tools.length).toBe(4)
    expect(callArgs.tool_choice).toBe('auto')
    // The system prompt should reference the owner by name.
    expect(callArgs.messages[0].content).toContain('TestOwner')
  })

  it('invokes get_daily_summary when the owner asks for a summary', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_sum_1',
                type: 'function',
                function: { name: 'get_daily_summary', arguments: '{}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 10 },
    })
    mockCreate.mockResolvedValueOnce({
      choices: [
        { message: { content: 'Hoy 0 mensajes, 0 citas, sin escalaciones.', tool_calls: undefined } },
      ],
      usage: { prompt_tokens: 130, completion_tokens: 18 },
    })

    const result = await ownerAssistantService.handle(seed.businessA.id, ownerConvA.id, '¿cómo va?')
    assert(result.ok)
    expect(result.data.toolsExecuted).toContain('get_daily_summary')

    // Stored conversation should have user + assistant(with tool_calls) + tool + assistant final
    const stored = await db
      .select()
      .from(messages)
      .where(eq(messages.conversationId, ownerConvA.id))
    expect(stored.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
  })

  it('pauses the bot when the owner confirms, via the pause_bot tool', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_pause_1',
                type: 'function',
                function: { name: 'pause_bot', arguments: '{"reason":"corte de luz"}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 90, completion_tokens: 8 },
    })
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Listo, bot pausado.', tool_calls: undefined } }],
      usage: { prompt_tokens: 140, completion_tokens: 6 },
    })

    const result = await ownerAssistantService.handle(
      seed.businessA.id,
      ownerConvA.id,
      'pausá el bot, ya confirmé',
    )
    assert(result.ok)
    expect(result.data.toolsExecuted).toContain('pause_bot')

    const [biz] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, seed.businessA.id))
    const settings = biz?.settings as { botPaused?: { paused: boolean; reason?: string } } | null
    expect(settings?.botPaused?.paused).toBe(true)
    expect(settings?.botPaused?.reason).toBe('corte de luz')
  })

  it('resumes the bot via the resume_bot tool', async () => {
    // First pause it directly so we have a paused state to clear.
    const [biz] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, seed.businessA.id))
    const baseSettings = biz?.settings as Record<string, unknown>
    await db
      .update(businesses)
      .set({
        settings: {
          ...baseSettings,
          botPaused: {
            paused: true,
            pausedAt: new Date().toISOString(),
            reason: 'manual',
          },
        },
      })
      .where(eq(businesses.id, seed.businessA.id))

    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_resume_1',
                type: 'function',
                function: { name: 'resume_bot', arguments: '{}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 80, completion_tokens: 4 },
    })
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'Bot reanudado.', tool_calls: undefined } }],
      usage: { prompt_tokens: 100, completion_tokens: 4 },
    })

    const result = await ownerAssistantService.handle(seed.businessA.id, ownerConvA.id, 'reanudá')
    assert(result.ok)
    expect(result.data.toolsExecuted).toContain('resume_bot')

    const [biz2] = await db
      .select()
      .from(businesses)
      .where(eq(businesses.id, seed.businessA.id))
    const settings = biz2?.settings as { botPaused: unknown } | null
    expect(settings?.botPaused).toBeNull()
  })

  it('returns the appointments list via get_appointments', async () => {
    mockCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'call_appts_1',
                type: 'function',
                function: {
                  name: 'get_appointments',
                  arguments: '{"date_from":"2026-06-16","date_to":"2026-06-20"}',
                },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 90, completion_tokens: 14 },
    })
    mockCreate.mockResolvedValueOnce({
      choices: [{ message: { content: 'No tenés nada en ese rango.', tool_calls: undefined } }],
      usage: { prompt_tokens: 140, completion_tokens: 10 },
    })

    const result = await ownerAssistantService.handle(
      seed.businessA.id,
      ownerConvA.id,
      '¿qué tengo del 16 al 20?',
    )
    assert(result.ok)
    expect(result.data.toolsExecuted).toContain('get_appointments')
  })

  it('isolation: owner_thread of businessA is not visible from businessB', async () => {
    const fromB = await conversationService.findOrCreateOwnerThread(seed.businessB.id)
    assert(fromB.ok)
    expect(fromB.data.id).not.toBe(ownerConvA.id)

    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.type, 'owner_thread'))
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.businessId).sort()).toEqual(
      [seed.businessA.id, seed.businessB.id].sort(),
    )
  })
})
