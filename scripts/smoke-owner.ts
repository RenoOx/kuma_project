import { logger } from '@/config/logger.js'
import { db, queryClient } from '@/db/client.js'
import { businesses } from '@/db/schema/index.js'
import * as businessService from '@/modules/business/business.service.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as ownerAssistantService from '@/modules/ownerAssistant/ownerAssistant.service.js'
import { eq } from 'drizzle-orm'

const PRICE_PER_M_INPUT_USD = 0.15
const PRICE_PER_M_OUTPUT_USD = 0.6

async function main(): Promise<void> {
  let createdBusinessId: string | null = null
  try {
    const [business] = await db
      .insert(businesses)
      .values({
        name: 'Barbería Test Owner',
        whatsappNumber: '+51900005555',
        ownerWhatsappNumber: '+51999000111',
        ownerName: 'TestOwner',
      })
      .returning()
    if (!business) throw new Error('seed business failed')
    createdBusinessId = business.id

    const settingsUpdate = await businessService.updateSettings(business.id, {
      operatingHours: {
        monday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
        tuesday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
        wednesday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
        thursday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
        friday: { open: '09:00', close: '19:00', break: { start: '13:00', end: '14:00' } },
        saturday: { open: '09:00', close: '13:00' },
        sunday: null,
      },
      slotDurationMinutes: 60,
      services: [
        { name: 'corte', durationMinutes: 30 },
        { name: 'barba', durationMinutes: 20 },
      ],
    })
    if (!settingsUpdate.ok) throw settingsUpdate.error

    const threadResult = await conversationService.findOrCreateOwnerThread(business.id)
    if (!threadResult.ok) throw threadResult.error
    const thread = threadResult.data
    logger.info({ businessId: business.id, ownerThreadId: thread.id }, 'owner thread ready')

    // 1) Daily summary.
    const summaryResult = await ownerAssistantService.handle(business.id, thread.id, '¿cómo va el día?')
    if (!summaryResult.ok) throw summaryResult.error
    logger.info(
      {
        reply: summaryResult.data.content,
        toolsExecuted: summaryResult.data.toolsExecuted,
        tokensInput: summaryResult.data.tokensInput,
        tokensOutput: summaryResult.data.tokensOutput,
      },
      'step 1 — daily summary',
    )

    // 2) Pause request (no confirmation yet). The model is expected to ASK
    // for confirmation; it must NOT pause yet.
    const pauseAskResult = await ownerAssistantService.handle(business.id, thread.id, 'pausá el bot')
    if (!pauseAskResult.ok) throw pauseAskResult.error
    logger.info(
      { reply: pauseAskResult.data.content, toolsExecuted: pauseAskResult.data.toolsExecuted },
      'step 2 — pause request (expects confirmation)',
    )

    const isPausedAfterAsk = await businessService.isBotPaused(business.id)
    if (isPausedAfterAsk) {
      throw new Error(
        'Bot was paused without explicit confirmation — model violated the rule',
      )
    }

    // 3) Confirmation.
    const confirmResult = await ownerAssistantService.handle(business.id, thread.id, 'sí, dale')
    if (!confirmResult.ok) throw confirmResult.error
    logger.info(
      { reply: confirmResult.data.content, toolsExecuted: confirmResult.data.toolsExecuted },
      'step 3 — confirmation',
    )
    const isPausedAfterConfirm = await businessService.isBotPaused(business.id)
    if (!isPausedAfterConfirm) {
      throw new Error('Bot is still NOT paused after confirmation')
    }

    // 4) Resume.
    const resumeResult = await ownerAssistantService.handle(business.id, thread.id, 'reanudá')
    if (!resumeResult.ok) throw resumeResult.error
    logger.info(
      { reply: resumeResult.data.content, toolsExecuted: resumeResult.data.toolsExecuted },
      'step 4 — resume',
    )
    const isPausedAfterResume = await businessService.isBotPaused(business.id)
    if (isPausedAfterResume) {
      throw new Error('Bot is still paused after resume')
    }

    const totalIn =
      summaryResult.data.tokensInput +
      pauseAskResult.data.tokensInput +
      confirmResult.data.tokensInput +
      resumeResult.data.tokensInput
    const totalOut =
      summaryResult.data.tokensOutput +
      pauseAskResult.data.tokensOutput +
      confirmResult.data.tokensOutput +
      resumeResult.data.tokensOutput
    const costUsd =
      (totalIn / 1_000_000) * PRICE_PER_M_INPUT_USD +
      (totalOut / 1_000_000) * PRICE_PER_M_OUTPUT_USD

    logger.info(
      {
        totalTokensInput: totalIn,
        totalTokensOutput: totalOut,
        costUsd: costUsd.toFixed(6),
      },
      'smoke complete — token totals',
    )
  } finally {
    if (createdBusinessId !== null) {
      await db.delete(businesses).where(eq(businesses.id, createdBusinessId))
      logger.info({ businessId: createdBusinessId }, 'cleaned up smoke test data via cascade delete')
    }
    await queryClient.end().catch(() => undefined)
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'smoke owner failed')
  process.exit(1)
})
