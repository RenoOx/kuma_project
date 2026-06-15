import { asc, eq } from 'drizzle-orm'
import { logger } from '../src/config/logger.js'
import { db, queryClient } from '../src/db/client.js'
import { businesses, conversations, customers, messages } from '../src/db/schema/index.js'

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
        .values({ name: 'Test Barbería', whatsappNumber: '+51900000099' })
        .returning()
      if (!business) throw new Error('insert business returned no row')

      const [customer] = await tx
        .insert(customers)
        .values({ businessId: business.id, phone: '+51911222333', name: 'Juan Pérez' })
        .returning()
      if (!customer) throw new Error('insert customer returned no row')

      const [conversation] = await tx
        .insert(conversations)
        .values({ businessId: business.id, customerId: customer.id })
        .returning()
      if (!conversation) throw new Error('insert conversation returned no row')

      await tx.insert(messages).values([
        {
          conversationId: conversation.id,
          businessId: business.id,
          role: 'user',
          content: 'Hola, quiero un corte para mañana al mediodía',
        },
        {
          conversationId: conversation.id,
          businessId: business.id,
          role: 'assistant',
          content: '¡Hola Juan! Mañana a las 12:00 tengo disponible, ¿lo agendo?',
        },
      ])

      const history = await tx
        .select({
          id: messages.id,
          role: messages.role,
          content: messages.content,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.conversationId, conversation.id))
        .orderBy(asc(messages.createdAt))

      logger.info(
        {
          conversation: {
            id: conversation.id,
            status: conversation.status,
            businessId: conversation.businessId,
            customerId: conversation.customerId,
            customerName: customer.name,
          },
          messages: history,
        },
        'fetched conversation with ordered message history',
      )

      throw new RollbackSignal()
    })
  } catch (err) {
    if (err instanceof RollbackSignal) {
      logger.info('transaction rolled back as intended (smoke test cleanup)')
    } else {
      logger.fatal({ err }, 'smoke conversation failed')
      throw err
    }
  } finally {
    await queryClient.end().catch(() => undefined)
  }
}

main().catch(() => {
  process.exit(1)
})
