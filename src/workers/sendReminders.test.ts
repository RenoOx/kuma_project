import { db } from '@/db/client.js'
import {
  appointments,
  type Appointment,
  type Business,
  type Customer,
} from '@/db/schema/index.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import {
  buildReminder24hText,
  buildReminder2hText,
  formatTime12h,
} from '@/workers/reminderTexts.js'
import { sendDueReminders } from '@/workers/sendReminders.js'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeDb,
  resetDb,
  seedTwoBusinesses,
  type TwoBusinessesSeed,
} from '../../tests/helpers/db.js'

// Mock the registry so we never touch a real Baileys client.
const { mockGetClient } = vi.hoisted(() => ({ mockGetClient: vi.fn() }))

vi.mock('@/modules/whatsapp/clientRegistry.js', () => ({
  getClient: mockGetClient,
  registerClient: vi.fn(),
  unregisterClient: vi.fn(),
  _resetRegistryForTests: vi.fn(),
}))

interface FakeClient {
  sendMessage: ReturnType<typeof vi.fn>
}

function makeFakeClient(): FakeClient {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) }
}

const NOW_ISO = '2026-07-06T15:00:00-05:00' // Monday, 3pm Lima
const fakeNowMs = new Date(NOW_ISO).getTime()

async function insertAppointment(
  businessId: string,
  customerId: string,
  scheduledAt: Date,
  overrides: Partial<typeof appointments.$inferInsert> = {},
): Promise<Appointment> {
  const [row] = await db
    .insert(appointments)
    .values({
      businessId,
      customerId,
      service: 'corte',
      scheduledAt,
      durationMinutes: 30,
      ...overrides,
    })
    .returning()
  if (!row) throw new Error('insert appointment failed')
  return row
}

describe('sendDueReminders worker', () => {
  let seed: TwoBusinessesSeed
  let customerA: Customer
  let fake: FakeClient

  beforeEach(async () => {
    await resetDb()
    seed = await seedTwoBusinesses()
    customerA = await customerRepo.create({
      businessId: seed.businessA.id,
      phone: '+51900012345',
      name: 'Cliente Test',
    })
    fake = makeFakeClient()
    mockGetClient.mockReset()
    mockGetClient.mockReturnValue(fake)
  })

  afterAll(async () => {
    await closeDb()
  })

  it('sends the 24h reminder for an appointment scheduled ~24h ahead and marks it', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fakeNowMs)
    try {
      // 24h ahead = 2026-07-07T15:00 Lima.
      const appt = await insertAppointment(
        seed.businessA.id,
        customerA.id,
        new Date('2026-07-07T15:00:00-05:00'),
      )

      const result = await sendDueReminders()

      expect(result.sent24h).toBe(1)
      expect(result.sent2h).toBe(0)
      expect(result.errors).toBe(0)
      expect(fake.sendMessage).toHaveBeenCalledTimes(1)
      const [jid, text] = fake.sendMessage.mock.calls[0] ?? []
      expect(jid).toBe('51900012345@s.whatsapp.net')
      expect(text).toContain('Te recuerdo tu cita')
      expect(text).toContain('Cliente Test')

      const [row] = await db.select().from(appointments).where(eq(appointments.id, appt.id))
      expect(row?.reminder24hSentAt).not.toBeNull()
      expect(row?.reminder2hSentAt).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('does NOT re-send the 24h reminder when reminder_24h_sent_at is already set', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fakeNowMs)
    try {
      await insertAppointment(
        seed.businessA.id,
        customerA.id,
        new Date('2026-07-07T15:00:00-05:00'),
        { reminder24hSentAt: new Date('2026-07-06T10:00:00-05:00') },
      )

      const result = await sendDueReminders()

      expect(result.sent24h).toBe(0)
      expect(result.errors).toBe(0)
      expect(fake.sendMessage).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('sends the 2h reminder for an appointment ~2h ahead and marks the 2h column only', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fakeNowMs)
    try {
      // 2h ahead = 2026-07-06T17:00 Lima.
      const appt = await insertAppointment(
        seed.businessA.id,
        customerA.id,
        new Date('2026-07-06T17:00:00-05:00'),
        // Pretend the 24h reminder already went out so this run only sends 2h.
        { reminder24hSentAt: new Date('2026-07-05T17:00:00-05:00') },
      )

      const result = await sendDueReminders()

      expect(result.sent24h).toBe(0)
      expect(result.sent2h).toBe(1)
      expect(fake.sendMessage).toHaveBeenCalledTimes(1)
      const [, text] = fake.sendMessage.mock.calls[0] ?? []
      expect(text).toContain('hoy a las')
      expect(text).toContain('en 2 horas')

      const [row] = await db.select().from(appointments).where(eq(appointments.id, appt.id))
      expect(row?.reminder2hSentAt).not.toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('does NOT re-send the 2h reminder if reminder_2h_sent_at is already set', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fakeNowMs)
    try {
      await insertAppointment(
        seed.businessA.id,
        customerA.id,
        new Date('2026-07-06T17:00:00-05:00'),
        {
          reminder24hSentAt: new Date('2026-07-05T17:00:00-05:00'),
          reminder2hSentAt: new Date('2026-07-06T15:00:00-05:00'),
        },
      )

      const result = await sendDueReminders()

      expect(result.sent2h).toBe(0)
      expect(result.errors).toBe(0)
      expect(fake.sendMessage).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it("renders '¡Hola!' (no trailing space) when the customer has no name", async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fakeNowMs)
    try {
      const anon = await customerRepo.create({
        businessId: seed.businessA.id,
        phone: '+51900099999',
        name: null,
      })
      await insertAppointment(
        seed.businessA.id,
        anon.id,
        new Date('2026-07-07T15:00:00-05:00'),
      )

      const result = await sendDueReminders()

      expect(result.sent24h).toBe(1)
      const [, text] = fake.sendMessage.mock.calls[0] ?? []
      expect(text).toContain('¡Hola!')
      expect(text).not.toContain('¡Hola !')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('reminderTexts formatting', () => {
  const business: Pick<Business, 'name' | 'timezone'> = {
    name: 'Barbería La Fina',
    timezone: 'America/Lima',
  }

  it('buildReminder24hText produces the exact format with name + date + business', () => {
    const customer: Pick<Customer, 'name'> = { name: 'Juan' }
    const appointment: Pick<Appointment, 'scheduledAt'> = {
      scheduledAt: new Date('2026-07-07T11:00:00-05:00'), // martes 7 de julio 11:00am
    }

    const text = buildReminder24hText(customer, business, appointment)
    expect(text).toBe(
      [
        '👋 ¡Hola Juan!',
        '',
        'Te recuerdo tu cita 📅 *martes 7 de julio a las 11:00am* en Barbería La Fina.',
      ].join('\n'),
    )
  })

  it('formats the day-of-week in lowercase Spanish ("sábado") for a known Saturday', () => {
    const customer: Pick<Customer, 'name'> = { name: 'Ana' }
    const appointment: Pick<Appointment, 'scheduledAt'> = {
      scheduledAt: new Date('2026-06-20T16:00:00-05:00'), // sábado 20 de junio
    }

    const text = buildReminder24hText(customer, business, appointment)
    expect(text).toContain('sábado 20 de junio')
    expect(text).toContain('4:00pm')
  })

  it('formatTime12h emits "11:00am" / "2:30pm" lowercase with no space', () => {
    const morning = formatTime12h(new Date('2026-07-07T11:00:00-05:00'), 'America/Lima')
    expect(morning).toBe('11:00am')

    const afternoon = formatTime12h(new Date('2026-07-07T14:30:00-05:00'), 'America/Lima')
    expect(afternoon).toBe('2:30pm')

    // Across timezones: same instant looks different in Mexico City (-06:00).
    const cdmx = formatTime12h(new Date('2026-07-07T11:00:00-05:00'), 'America/Mexico_City')
    expect(cdmx).toBe('10:00am')
  })

  it('buildReminder2hText carries the "hoy a las X (en 2 horas)" phrase verbatim', () => {
    const customer: Pick<Customer, 'name'> = { name: 'Pedro' }
    const appointment: Pick<Appointment, 'scheduledAt'> = {
      scheduledAt: new Date('2026-07-07T16:00:00-05:00'),
    }
    const text = buildReminder2hText(customer, business, appointment)
    expect(text).toBe(
      [
        '⏰ ¡Hola Pedro!',
        '',
        'Tu cita en Barbería La Fina es *hoy a las 4:00pm* (en 2 horas).',
      ].join('\n'),
    )
  })
})

