import { logger } from '@/config/logger.js'
import { db, queryClient } from '@/db/client.js'
import { businesses, knowledgeBase as kbTable } from '@/db/schema/index.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as customerService from '@/modules/customer/customer.service.js'
import * as llmService from '@/modules/llm/llm.service.js'
import * as messageService from '@/modules/message/message.service.js'
import { eq } from 'drizzle-orm'

// gpt-4o-mini pricing as of late 2025 / early 2026. Update if OpenAI moves these.
const PRICE_PER_M_INPUT_USD = 0.15
const PRICE_PER_M_OUTPUT_USD = 0.6

async function main(): Promise<void> {
  let createdBusinessId: string | null = null
  try {
    const [business] = await db
      .insert(businesses)
      .values({ name: 'Barbería Test Tools', whatsappNumber: '+51900000999' })
      .returning()
    if (!business) throw new Error('seed business failed')
    createdBusinessId = business.id

    await db.insert(kbTable).values([
      {
        businessId: business.id,
        category: 'services',
        content: 'Corte de cabello, barba, cejas, lavado.',
      },
      {
        businessId: business.id,
        category: 'pricing',
        content: 'Corte: S/30. Barba: S/20. Cejas: S/10.',
      },
      {
        businessId: business.id,
        category: 'hours',
        content: 'Lunes a sábado de 9am a 8pm. Domingos cerrado.',
      },
    ])
    logger.info({ businessId: business.id }, 'seeded business with 3 knowledge_base entries')

    const customerResult = await customerService.getOrCreate(
      business.id,
      '+51901112222',
      'Juan',
    )
    if (!customerResult.ok) throw customerResult.error

    const conversationResult = await conversationService.getOrCreateOpen(
      business.id,
      customerResult.data.id,
    )
    if (!conversationResult.ok) throw conversationResult.error
    const conv = conversationResult.data

    const userText = '¿Qué horarios tienen mañana para un corte?'
    const userMsgResult = await messageService.append({
      businessId: business.id,
      conversationId: conv.id,
      role: 'user',
      content: userText,
    })
    if (!userMsgResult.ok) throw userMsgResult.error

    logger.info({ userText }, 'asking the LLM (expecting check_availability tool call)')
    const replyResult = await llmService.generateReply({
      businessId: business.id,
      conversationId: conv.id,
      userMessage: userText,
    })
    if (!replyResult.ok) throw replyResult.error

    const { content, tokensInput, tokensOutput, toolCallsExecuted, escalated, maxIterationsHit } =
      replyResult.data
    const costUsd =
      (tokensInput / 1_000_000) * PRICE_PER_M_INPUT_USD +
      (tokensOutput / 1_000_000) * PRICE_PER_M_OUTPUT_USD

    logger.info({ reply: content }, 'LLM final reply')
    logger.info(
      {
        toolsExecuted: toolCallsExecuted.map((t) => ({
          name: t.name,
          args: t.args,
          resultPreview:
            typeof t.result === 'string' ? t.result.slice(0, 120) : String(t.result),
          error: t.error,
        })),
        escalated,
        maxIterationsHit,
      },
      'tools executed during the turn',
    )
    logger.info(
      {
        tokensInput,
        tokensOutput,
        costUsd: costUsd.toFixed(6),
        model: 'gpt-4o-mini',
      },
      'token usage and estimated cost (USD)',
    )
  } finally {
    if (createdBusinessId !== null) {
      await db.delete(businesses).where(eq(businesses.id, createdBusinessId))
      logger.info(
        { businessId: createdBusinessId },
        'cleaned up smoke test data via cascade delete',
      )
    }
    await queryClient.end().catch(() => undefined)
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'smoke tools failed')
  process.exit(1)
})
