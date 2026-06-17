// Shared timezone helpers for the owner assistant. Used by both the tool
// executor (to bracket "today" for queries) and the daily report builder.

export function todayInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

// Resolves a YYYY-MM-DD calendar date to the UTC [start, end) range that
// represents that day in `timezone`.
export function dayRangeInTimezone(
  dateISO: string,
  timezone: string,
): { start: Date; end: Date } | null {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
    })
    const sample = new Date(`${dateISO}T12:00:00Z`)
    const tzName = formatter
      .formatToParts(sample)
      .find((p) => p.type === 'timeZoneName')?.value
    if (!tzName) return null
    const offset =
      tzName === 'GMT'
        ? '+00:00'
        : (() => {
            const m = tzName.replace(/^GMT/, '').match(/^([+-])(\d{1,2})(?::?(\d{2}))?$/)
            if (!m) return null
            return `${m[1]}${(m[2] ?? '00').padStart(2, '0')}:${m[3] ?? '00'}`
          })()
    if (!offset) return null
    const start = new Date(`${dateISO}T00:00:00${offset}`)
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000)
    return { start, end }
  } catch {
    return null
  }
}

// dateISO + offsetDays (positive or negative) → YYYY-MM-DD in the same tz.
export function shiftDateISO(dateISO: string, offsetDays: number): string {
  const parts = dateISO.split('-').map(Number)
  const [y, m, d] = parts
  if (parts.length !== 3 || !y || !m || !d) return dateISO
  const utc = new Date(Date.UTC(y, m - 1, d) + offsetDays * 24 * 60 * 60 * 1000)
  const yy = utc.getUTCFullYear()
  const mm = String(utc.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(utc.getUTCDate()).padStart(2, '0')
  return `${yy}-${mm}-${dd}`
}
