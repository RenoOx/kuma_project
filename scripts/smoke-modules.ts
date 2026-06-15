import { logger } from '@/config/logger.js'
import { db, queryClient } from '@/db/client.js'
import { businesses } from '@/db/schema/index.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as customerService from '@/modules/customer/customer.service.js'
import * as messageService from '@/modules/message/message.service.js'
import { eq } from 'drizzle-orm'

// We cannot wrap the whole smoke in db.transaction(...): the services run
// through the singleton `db` connection, which under READ COMMITTED cannot
// see uncommitted rows from a sibling transaction. So we seed the business
// outside any transaction and clean up via cascade delete at the end.
async function main(): Promise<void> {
  let createdBusinessId: string | null = null
  try {
    const [business] = await db
      .insert(businesses)
      .values({ name: 'Test Barbería', whatsappNumber: '+51900000999' })
      .returning()
    if (!business) throw new Error('seed business returned no row')
    createdBusinessId = business.id

    const customerResult = await customerService.getOrCreate(business.id, '+51900111222', 'Juan')
    if (!customerResult.ok) throw customerResult.error
    const customer = customerResult.data

    const conversationResult = await conversationService.getOrCreateOpen(business.id, customer.id)
    if (!conversationResult.ok) throw conversationResult.error
    const conversation = conversationResult.data

    const userMsg = await messageService.append({
      businessId: business.id,
      conversationId: conversation.id,
      role: 'user',
      content: 'Hola, quiero un corte',
    })
    if (!userMsg.ok) throw userMsg.error

    const assistantMsg = await messageService.append({
      businessId: business.id,
      conversationId: conversation.id,
      role: 'assistant',
      content: '¡Hola Juan! ¿Para cuándo te agendo?',
    })
    if (!assistantMsg.ok) throw assistantMsg.error

    const history = await messageService.getRecentHistory(business.id, conversation.id, 15)
    if (!history.ok) throw history.error

    logger.info(
      {
        businessId: business.id,
        customerId: customer.id,
        customerName: customer.name,
        conversationId: conversation.id,
        conversationStatus: conversation.status,
        history: history.data.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        })),
      },
      'fetched conversation history via service layer',
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
  logger.fatal({ err }, 'smoke modules failed')
  process.exit(1)
})
