/**
 * Single source of truth for turning a stored instant into something a person
 * reads.
 *
 * `appointments.scheduled_at` is a timestamptz — UTC on disk, which is right for
 * storage. What was wrong was letting that UTC value escape: the owner tools
 * handed the model a raw `toISOString()` and left it to work out the business's
 * wall clock on its own, and four other call sites rendered 24-hour times. The
 * owner ended up reading "20:00" for an 8pm appointment, or worse, the UTC hour.
 *
 * Every hour shown to a human — owner or patient — goes through here.
 */

/** "10:00am", "2:30pm", "12:00pm". Rendered in the business's timezone. */
export function formatTimeForDisplay(date: Date, timezone: string): string {
  try {
    // en-US gives "10:00 AM"; we lowercase the period and drop the space to
    // match the format used across Emma's messages. Spanish locales render it
    // as "a. m." with punctuation, which is why the locale is not es-PE here.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).formatToParts(date)

    const hour = parts.find((p) => p.type === 'hour')?.value ?? ''
    const minute = parts.find((p) => p.type === 'minute')?.value ?? ''
    const dayPeriod = parts.find((p) => p.type === 'dayPeriod')?.value ?? ''
    return `${hour}:${minute}${dayPeriod.toLowerCase().replace(/[\s.]/g, '')}`
  } catch {
    // Unknown timezone: better a UTC-ish time than a crash mid-reply.
    return date.toISOString().slice(11, 16)
  }
}

/** "martes 19 de agosto, 10:00am". Rendered in the business's timezone. */
export function formatDateTimeForDisplay(date: Date, timezone: string): string {
  try {
    // Some Node/ICU builds capitalise the month but not the weekday; forcing
    // lowercase keeps the phrase consistent across environments.
    const weekday = new Intl.DateTimeFormat('es-PE', { timeZone: timezone, weekday: 'long' })
      .format(date)
      .toLowerCase()
    const day = new Intl.DateTimeFormat('es-PE', { timeZone: timezone, day: 'numeric' }).format(date)
    const month = new Intl.DateTimeFormat('es-PE', { timeZone: timezone, month: 'long' })
      .format(date)
      .toLowerCase()

    return `${weekday} ${day} de ${month}, ${formatTimeForDisplay(date, timezone)}`
  } catch {
    return date.toISOString()
  }
}
