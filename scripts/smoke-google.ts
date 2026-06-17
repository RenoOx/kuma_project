import { logger } from '@/config/logger.js'
import { db, queryClient } from '@/db/client.js'
import { businesses } from '@/db/schema/index.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as businessService from '@/modules/business/business.service.js'
import * as customerService from '@/modules/customer/customer.service.js'
import * as googleCredentialsRepo from '@/modules/google/googleCredentials.repo.js'
import { eq } from 'drizzle-orm'

// This smoke does NOT touch the real Google API. Instead it seeds a fake
// google_credentials row and overrides the calendar service via the same
// mocking pattern we use in tests. The point is to verify the wiring around
// bookAppointment when Google IS connected, without depending on TLS access
// to googleapis.com (which the corp network intercepts).
// We monkey-patch the calendar service after import to keep the smoke
// self-contained.
const calendarService = await import('@/modules/google/googleCalendar.service.js')
const originalCreateEvent = calendarService.createEvent
;(calendarService as { createEvent: typeof originalCreateEvent }).createEvent = async (params) => {
  logger.info({ tool: 'mock', businessId: params.businessId }, 'mock calendar createEvent invoked')
  return {
    ok: true,
    data: {
      googleEventId: 'evt-smoke-mock-1',
      htmlLink: 'https://calendar.google.com/event?eid=mock',
    },
  }
}

const NEXT_MONDAY_ISO = '2026-07-06'

async function main(): Promise<void> {
  let createdBusinessId: string | null = null
  try {
    const [business] = await db
      .insert(businesses)
      .values({ name: 'Barbería Test Google', whatsappNumber: '+51900006666' })
      .returning()
    if (!business) throw new Error('seed business failed')
    createdBusinessId = business.id

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

    // Seed a fake google_credentials row so the business is "Google-connected".
    await googleCredentialsRepo.upsert({
      businessId: business.id,
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      calendarId: 'primary',
      connectedEmail: 'mock-owner@example.com',
    })
    logger.info({ businessId: business.id }, 'seeded fake google credentials')

    const customerResult = await customerService.getOrCreate(business.id, '+51901112222', 'Juan')
    if (!customerResult.ok) throw customerResult.error

    const result = await appointmentService.bookAppointment({
      businessId: business.id,
      customerId: customerResult.data.id,
      service: 'corte',
      datetimeISO: `${NEXT_MONDAY_ISO}T15:00:00-05:00`,
    })
    if (!result.ok) throw result.error

    logger.info(
      {
        appointmentId: result.data.id,
        googleEventId: result.data.googleEventId,
        service: result.data.service,
        scheduledAt: result.data.scheduledAt.toISOString(),
        status: result.data.status,
      },
      'appointment created with mocked Google sync',
    )

    if (result.data.googleEventId !== 'evt-smoke-mock-1') {
      throw new Error(`expected googleEventId 'evt-smoke-mock-1', got ${result.data.googleEventId}`)
    }
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
  logger.fatal({ err }, 'smoke google failed')
  process.exit(1)
})
