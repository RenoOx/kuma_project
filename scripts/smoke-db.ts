import { eq } from 'drizzle-orm'
import { logger } from '../src/config/logger.js'
import { db, queryClient } from '../src/db/client.js'
import { businesses, knowledgeBase } from '../src/db/schema/index.js'

class RollbackSignal extends Error {
  constructor() {
    super('intentional rollback for smoke test cleanup')
    this.name = 'RollbackSignal'
  }
}

async function main(): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      const [business] = await tx
        .insert(businesses)
        .values({
          name: 'Test Barbería',
          whatsappNumber: '+51900000000',
        })
        .returning()

      if (!business) {
        throw new Error('insert business returned no row')
      }
      logger.info({ businessId: business.id, name: business.name }, 'inserted business')

      const entries = await tx
        .insert(knowledgeBase)
        .values([
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
        ])
        .returning()
      logger.info({ count: entries.length }, 'inserted knowledge base entries')

      const rows = await tx
        .select({
          businessId: businesses.id,
          businessName: businesses.name,
          whatsappNumber: businesses.whatsappNumber,
          timezone: businesses.timezone,
          entryId: knowledgeBase.id,
          entryCategory: knowledgeBase.category,
          entryContent: knowledgeBase.content,
        })
        .from(businesses)
        .leftJoin(knowledgeBase, eq(knowledgeBase.businessId, businesses.id))
        .where(eq(businesses.id, business.id))

      const head = rows[0]
      if (!head) {
        throw new Error('join returned no rows')
      }

      const grouped = {
        id: head.businessId,
        name: head.businessName,
        whatsappNumber: head.whatsappNumber,
        timezone: head.timezone,
        knowledgeBase: rows
          .filter((r) => r.entryId !== null)
          .map((r) => ({
            id: r.entryId,
            category: r.entryCategory,
            content: r.entryContent,
          })),
      }

      logger.info({ business: grouped }, 'fetched business with knowledge base via join')

      throw new RollbackSignal()
    })
  } catch (err) {
    if (err instanceof RollbackSignal) {
      logger.info('transaction rolled back as intended (smoke test cleanup)')
    } else {
      logger.fatal({ err }, 'smoke test failed inside transaction')
      throw err
    }
  } finally {
    await queryClient.end().catch(() => undefined)
  }
}

main().catch(() => {
  process.exit(1)
})
