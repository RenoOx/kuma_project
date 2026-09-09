import type { Appointment, Business, Customer } from '@/db/schema/index.js'
import { formatTimeForDisplay } from '@/shared/datetime.js'
import { formatPersonName } from '@/shared/name.js'

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
  // Same formatter the owner's appointment lists use: the patient must not be
  // "juan perez" in the reminder and "Juan Pérez" on the owner's screen.
  const name = formatPersonName(customer.name)
  return name ? `${emoji} ¡Hola ${name}!` : `${emoji} ¡Hola!`
}

// A reminder run sends the same message to everyone on the day's list, minutes
// apart, from one number. Byte-identical text across twenty recipients is the
// cheapest broadcast signature there is, so each reminder picks one of several
// wordings — greeting emoji included, because a fixed first line leaves half the
// message identical no matter how the second one varies.
//
// None of these name a relative day ("mañana"): the full date is already in the
// line, and a relative word is one more thing that can be wrong at the edges of
// the reminder window.
interface ReminderVariant {
  emoji: string
  body: (when: string, businessName: string) => string
}

const REMINDER_24H_VARIANTS: ReadonlyArray<ReminderVariant> = [
  { emoji: '👋', body: (when, biz) => `Te recuerdo tu cita 📅 *${when}* en ${biz}.` },
  { emoji: '😊', body: (when, biz) => `Pasando a recordarte tu cita en ${biz} 📅 *${when}*.` },
  { emoji: '👋', body: (when, biz) => `Solo para recordarte: tu cita en ${biz} es el *${when}*.` },
  { emoji: '📅', body: (when, biz) => `Tu cita en ${biz} quedó agendada para el *${when}*.` },
  { emoji: '😊', body: (when, biz) => `Te esperamos en ${biz} el *${when}* 📅` },
]

const REMINDER_2H_VARIANTS: ReadonlyArray<ReminderVariant> = [
  { emoji: '⏰', body: (when, biz) => `Tu cita en ${biz} es *hoy a las ${when}* (en 2 horas).` },
  {
    emoji: '⏰',
    body: (when, biz) =>
      `Te recuerdo que tu cita en ${biz} es *hoy a las ${when}*, en un par de horas.`,
  },
  {
    emoji: '😊',
    body: (when, biz) => `En un rato te esperamos: tu cita en ${biz} es *hoy a las ${when}*.`,
  },
  { emoji: '⏰', body: (when, biz) => `Tu cita de *hoy a las ${when}* en ${biz} ya está cerquita.` },
  { emoji: '📌', body: (when, biz) => `Recordatorio: hoy a las *${when}* te esperamos en ${biz}.` },
]

/**
 * Picks a variant from a stable hash of the appointment id.
 *
 * Stable rather than random on purpose: a reminder that fails and is retried has
 * to arrive as the SAME message, not as a second, differently-worded reminder
 * for a cita the patient already read about.
 */
function pickVariant(variants: ReadonlyArray<ReminderVariant>, seed: string): ReminderVariant {
  let hash = 0
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0
  }
  // >>> 0 rather than Math.abs: the most negative 32-bit int is its own
  // absolute value, which would index off the front of the array.
  const variant = variants[(hash >>> 0) % variants.length] ?? variants[0]
  if (!variant) throw new Error('reminder variants must not be empty')
  return variant
}

export function buildReminder24hText(
  customer: Pick<Customer, 'name'>,
  business: Pick<Business, 'name' | 'timezone'>,
  appointment: Pick<Appointment, 'id' | 'scheduledAt'>,
): string {
  const date = appointment.scheduledAt
  const tz = business.timezone
  const when = `${formatDayOfWeek(date, tz)} ${formatDayOfMonth(date, tz)} de ${formatMonth(
    date,
    tz,
  )} a las ${formatTime12h(date, tz)}`

  const variant = pickVariant(REMINDER_24H_VARIANTS, appointment.id)
  return [buildGreeting(variant.emoji, customer), '', variant.body(when, business.name)].join('\n')
}

export function buildReminder2hText(
  customer: Pick<Customer, 'name'>,
  business: Pick<Business, 'name' | 'timezone'>,
  appointment: Pick<Appointment, 'id' | 'scheduledAt'>,
): string {
  const time = formatTime12h(appointment.scheduledAt, business.timezone)
  const variant = pickVariant(REMINDER_2H_VARIANTS, appointment.id)
  return [buildGreeting(variant.emoji, customer), '', variant.body(time, business.name)].join('\n')
}
