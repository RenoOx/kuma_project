import { logger } from '@/config/logger.js'
import { db, queryClient } from '@/db/client.js'
import { appointments, businesses } from '@/db/schema/index.js'
import * as businessService from '@/modules/business/business.service.js'
import * as customerService from '@/modules/customer/customer.service.js'
import type { WhatsappClient } from '@/modules/whatsapp/baileys.client.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { sendDueReminders } from '@/workers/sendReminders.js'
import { eq } from 'drizzle-orm'

interface FakeSend {
  jid: string
  text: string
}

function makeFakeClient(): { client: WhatsappClient; sent: FakeSend[] } {
  const sent: FakeSend[] = []
  const client: WhatsappClient = {
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
        name: 'Barbería Test Reminders',
        whatsappNumber: '+51900003333',
      })
      .returning()
    if (!business) throw new Error('seed business failed')
    createdBusinessId = business.id

    const settingsUpdate = await businessService.updateSettings(business.id, {
      operatingHours: {
        monday: { open: '09:00', close: '19:00' },
        tuesday: { open: '09:00', close: '19:00' },
        wednesday: { open: '09:00', close: '19:00' },
        thursday: { open: '09:00', close: '19:00' },
        friday: { open: '09:00', close: '19:00' },
        saturday: { open: '09:00', close: '13:00' },
        sunday: null,
      },
      slotDurationMinutes: 60,
      services: [{ name: 'corte', durationMinutes: 30 }],
    })
    if (!settingsUpdate.ok) throw settingsUpdate.error

    const customerResult = await customerService.getOrCreate(
      business.id,
      '+51901234567',
      'Cliente Smoke',
    )
    if (!customerResult.ok) throw customerResult.error
    const customer = customerResult.data

    // Schedule the appointment exactly 24h from now so it falls inside the
    // [now+23h, now+25h) 24h reminder window.
    const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
    const [appt] = await db
      .insert(appointments)
      .values({
        businessId: business.id,
        customerId: customer.id,
        service: 'corte',
        scheduledAt,
        durationMinutes: 30,
      })
      .returning()
    if (!appt) throw new Error('seed appointment failed')
    logger.info({ appointmentId: appt.id, scheduledAt }, 'seeded appointment 24h in the future')

    // Register a fake client so the worker captures the push instead of
    // hitting Baileys (which would fail at smoke time anyway).
    const { client: fake, sent } = makeFakeClient()
    clientRegistry.registerClient(business.id, fake)

    const result = await sendDueReminders()
    logger.info(result, 'sendDueReminders returned')

    if (result.sent24h !== 1 || result.sent2h !== 0 || result.errors !== 0) {
      throw new Error(
        `expected sent24h=1, sent2h=0, errors=0 but got ${JSON.stringify(result)}`,
      )
    }
    if (sent.length !== 1) {
      throw new Error(`expected 1 captured push, got ${sent.length}`)
    }
    const push = sent[0]
    if (!push) throw new Error('captured push missing')
    logger.info(
      { jid: push.jid, textPreview: push.text.slice(0, 120) },
      'reminder push captured by fake client',
    )

    const [row] = await db
      .select()
      .from(appointments)
      .where(eq(appointments.id, appt.id))
    if (!row?.reminder24hSentAt) {
      throw new Error('reminder_24h_sent_at was not set after a successful send')
    }
    logger.info(
      { reminder24hSentAt: row.reminder24hSentAt },
      'reminder_24h_sent_at column set as expected',
    )
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
  logger.fatal({ err }, 'smoke reminders failed')
  process.exit(1)
})
