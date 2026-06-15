import { logger } from '@/config/logger.js'
import { db, queryClient } from '@/db/client.js'
import { businesses } from '@/db/schema/index.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as businessService from '@/modules/business/business.service.js'
import { NotConfiguredError } from '@/shared/errors.js'
import { eq } from 'drizzle-orm'

// Future Monday in Lima time. Aligns with operatingHours[monday] in the
// settings we set below.
const MONDAY_ISO = '2026-07-06'

async function main(): Promise<void> {
  let createdBusinessId: string | null = null
  try {
    // 1. Create a business WITHOUT settings.
    const [business] = await db
      .insert(businesses)
      .values({ name: 'Barbería Sin Config', whatsappNumber: '+51900007777' })
      .returning()
    if (!business) throw new Error('seed business failed')
    createdBusinessId = business.id
    logger.info({ businessId: business.id }, 'created business with no settings')

    // 2. Scenario A: checkAvailability against an unconfigured business
    //    should return NotConfiguredError, NOT invent slots.
    const scenarioA = await appointmentService.checkAvailability(business.id, MONDAY_ISO, 'corte')
    if (scenarioA.ok) {
      throw new Error(`expected NotConfiguredError, got ok with ${scenarioA.data.availableSlots.length} slots`)
    }
    if (!(scenarioA.error instanceof NotConfiguredError)) {
      throw new Error(`expected NotConfiguredError, got ${scenarioA.error.code}`)
    }
    logger.info(
      {
        scenarioA_errorCode: scenarioA.error.code,
        scenarioA_missing: scenarioA.error.logContext.missing,
      },
      'Scenario A — unconfigured business correctly refused to invent slots',
    )

    // 3. Update settings with a realistic config (Mon–Sat 9–19 with break,
    //    Sunday closed, slot 60min, two services).
    const updateResult = await businessService.updateSettings(business.id, {
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
    if (!updateResult.ok) throw updateResult.error
    logger.info({ businessId: business.id }, 'settings applied successfully')

    // 4. Scenario B: same checkAvailability now returns real slots.
    const scenarioB = await appointmentService.checkAvailability(business.id, MONDAY_ISO, 'corte')
    if (!scenarioB.ok) throw scenarioB.error
    logger.info(
      {
        date: MONDAY_ISO,
        availableSlotsCount: scenarioB.data.availableSlots.length,
        availableSlots: scenarioB.data.availableSlots,
      },
      'Scenario B — configured business returned real slots (break excluded)',
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
  logger.fatal({ err }, 'smoke settings failed')
  process.exit(1)
})
