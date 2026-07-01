import { logger } from '@/config/logger.js'
import { db, queryClient } from '@/db/client.js'
import { businesses } from '@/db/schema/index.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as businessService from '@/modules/business/business.service.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import { generateDailyReportText } from '@/modules/ownerAssistant/dailyReport.js'
import type { WhatsappClient } from '@/modules/whatsapp/baileys.client.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { eq } from 'drizzle-orm'

interface FakeSend {
  jid: string
  text: string
}

function makeFakeClient(): { client: WhatsappClient; sent: FakeSend[] } {
  const sent: FakeSend[] = []
  const client: WhatsappClient = {
    // We don't need the full Baileys surface — a minimal stub is enough for
    // ownerNotifier which only calls sendMessage(jid, text).
    sock: {} as WhatsappClient['sock'],
    async sendMessage(jid, text) {
      sent.push({ jid, text })
    },
    onMessage() {
      // noop
    },
    onDisconnect() {
      // noop
    },
    onQR() {
      // noop
    },
    onConnect() {
      // noop
    },
  }
  return { client, sent }
}

async function main(): Promise<void> {
  let createdBusinessId: string | null = null
  try {
    const [business] = await db
      .insert(businesses)
      .values({
        name: 'Barbería Test Notif',
        whatsappNumber: '+51900004444',
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

    // 1) Register a fake WA client to capture outgoing pushes.
    const { client: fake, sent } = makeFakeClient()
    clientRegistry.registerClient(business.id, fake)

    // 2) Create a customer + a conversation so escalate has something to act on.
    const customer = await customerRepo.create({
      businessId: business.id,
      phone: '+51901234567',
      name: 'Cliente Notif',
    })
    const ownerThread = await conversationService.findOrCreateOwnerThread(business.id)
    if (!ownerThread.ok) throw ownerThread.error
    const customerConv = await conversationRepo.create({
      businessId: business.id,
      customerId: customer.id,
    })

    // 3) Escalate — should trigger notifyOwner fire-and-forget.
    const escResult = await appointmentService.escalate({
      businessId: business.id,
      conversationId: customerConv.id,
      reason: 'cliente molesto smoke',
    })
    if (!escResult.ok) throw escResult.error

    // Flush microtasks so the fire-and-forget notification runs.
    await new Promise((resolve) => setImmediate(resolve))

    if (sent.length !== 1) {
      throw new Error(`expected 1 push on escalate, got ${sent.length}`)
    }
    const escalateSend = sent[0]
    if (!escalateSend) throw new Error('escalate push missing')
    logger.info(
      { jid: escalateSend.jid, textPreview: escalateSend.text.slice(0, 80) },
      'escalation push captured by fake client',
    )

    // 4) generateDailyReportText returns the expected blocks.
    const reportText = await generateDailyReportText(business.id)
    logger.info({ reportText }, 'daily report text generated')
    if (!reportText.includes('Reporte de hoy')) {
      throw new Error('report missing header')
    }
    if (!reportText.includes('Mensajes recibidos')) {
      throw new Error('report missing messages line')
    }
    if (!reportText.includes('Escalaciones pendientes')) {
      throw new Error('report missing escalations line')
    }

    logger.info({ ownerThreadId: ownerThread.data.id }, 'smoke verified end-to-end')
  } finally {
    if (createdBusinessId !== null) {
      clientRegistry._resetRegistryForTests()
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
  logger.fatal({ err }, 'smoke notifications failed')
  process.exit(1)
})
