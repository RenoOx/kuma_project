import type { Appointment, Business, Customer } from '@/db/schema/index.js'
import { formatTimeForDisplay } from '@/shared/datetime.js'

// Day-of-week / day-of-month / month formatters all use es-PE so they come
// back lowercase ("sábado", "junio"). Time format uses en-US + manual
// lowercasing so we can squash the locale's "AM" → "am" without locale-
// specific quirks like Spanish's "a. m." punctuation.

// Some Node / ICU versions return the month already capitalised ("Junio")
// while the weekday comes lowercase ("sábado"). We force lowercase on both
// so the rendered reminder stays consistent across environments.
function formatDayOfWeek(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('es-PE', {
    timeZone: timezone,
    weekday: 'long',
  })
    .format(date)
    .toLowerCase()
}

function formatDayOfMonth(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('es-PE', { timeZone: timezone, day: 'numeric' }).format(date)
}

function formatMonth(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('es-PE', { timeZone: timezone, month: 'long' })
    .format(date)
    .toLowerCase()
}

// "11:00am" / "2:30pm". Kept as a named export because the reminder tests pin
// this exact shape, but the implementation now lives in shared/datetime so the
// owner tools, the patient notices and these reminders cannot drift apart.
export const formatTime12h = formatTimeForDisplay

function buildGreeting(emoji: string, customer: Pick<Customer, 'name'>): string {
  const name = customer.name?.trim()
  return name ? `${emoji} ¡Hola ${name}!` : `${emoji} ¡Hola!`
}

export function buildReminder24hText(
  customer: Pick<Customer, 'name'>,
  business: Pick<Business, 'name' | 'timezone'>,
  appointment: Pick<Appointment, 'scheduledAt'>,
): string {
  const date = appointment.scheduledAt
  const tz = business.timezone
  const dayOfWeek = formatDayOfWeek(date, tz)
  const day = formatDayOfMonth(date, tz)
  const month = formatMonth(date, tz)
  const time = formatTime12h(date, tz)

  return [
    buildGreeting('👋', customer),
    '',
    `Te recuerdo tu cita 📅 *${dayOfWeek} ${day} de ${month} a las ${time}* en ${business.name}.`,
  ].join('\n')
}

export function buildReminder2hText(
  customer: Pick<Customer, 'name'>,
  business: Pick<Business, 'name' | 'timezone'>,
  appointment: Pick<Appointment, 'scheduledAt'>,
): string {
  const time = formatTime12h(appointment.scheduledAt, business.timezone)
  return [
    buildGreeting('⏰', customer),
    '',
    `Tu cita en ${business.name} es *hoy a las ${time}* (en 2 horas).`,
  ].join('\n')
}
