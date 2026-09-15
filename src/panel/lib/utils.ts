import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Tailwind-aware class merge. The standard shadcn helper. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

const RELATIVE_UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
  ['second', 60],
  ['minute', 60],
  ['hour', 24],
  ['day', 7],
  ['week', 4.345],
  ['month', 12],
  ['year', Number.POSITIVE_INFINITY],
]

const relative = new Intl.RelativeTimeFormat('es-PE', { numeric: 'auto' })

/** "hace 5 minutos". Empty string for a missing date, never "Invalid Date". */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''

  let delta = (then - Date.now()) / 1000
  for (const [unit, step] of RELATIVE_UNITS) {
    if (Math.abs(delta) < step) return relative.format(Math.round(delta), unit)
    delta /= step
  }
  return relative.format(Math.round(delta), 'year')
}

const TIME_FMT = new Intl.DateTimeFormat('es-PE', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Lima',
})

const DATETIME_FMT = new Intl.DateTimeFormat('es-PE', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'America/Lima',
})

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : TIME_FMT.format(d)
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : DATETIME_FMT.format(d)
}

const LONG_FMT = new Intl.DateTimeFormat('es-PE', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'America/Lima',
})

/** "sábado, 20 de junio, 2:30 p.m." — the full form, for a detail view. */
export function formatLongDateTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : LONG_FMT.format(d)
}

const DATE_FMT = new Intl.DateTimeFormat('es-PE', {
  day: '2-digit',
  month: 'short',
  timeZone: 'America/Lima',
})

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : DATE_FMT.format(d)
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** Two-letter avatar seed. Falls back to the phone's last digits. */
export function initials(name: string | null | undefined, phone: string): string {
  const [first, second] = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (first && second) return (first.slice(0, 1) + second.slice(0, 1)).toUpperCase()
  if (first) return first.slice(0, 2).toUpperCase()
  return phone.replace(/\D/g, '').slice(-2)
}

/**
 * A phone number, grouped for reading.
 *
 * The number IS the contact's identity in this panel, so it gets read off the
 * screen out loud and typed into a phone — "+51 925 413 868" survives that,
 * "+51925413868" does not.
 *
 * Tolerant of both shapes in the database: the WhatsApp handler stores
 * "+51987654321" and the older admin form stored "51987654321" without the
 * plus (see shared/phone.ts).
 */
export function formatPhone(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '')
  if (digits.length === 0) return raw ?? ''

  // Peru mobile — 51 plus nine digits — is every number this panel serves today.
  if (digits.length === 11 && digits.startsWith('51')) {
    const local = digits.slice(2)
    return `+51 ${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`
  }

  // Anything else: group the last nine in threes and treat whatever precedes
  // them as the country code. Reads right across the region without pretending
  // to know every national format.
  const local = digits.slice(-9)
  const country = digits.slice(0, -9)
  const grouped = local.replace(/(\d{3})(?=\d)/g, '$1 ')
  return country ? `+${country} ${grouped}` : `+${grouped}`
}

/**
 * A service's price, in the three shapes it can take.
 *
 * Mirrors formatServicePrice on the server so the catalogue in the panel reads
 * exactly like the line Emma puts in her prompt. Kept in sync by hand, like the
 * rest of api/types.ts — the two builds cannot share a module.
 */
export function formatServicePrice(service: {
  priceMin: number | null
  priceMax: number | null
  requiresEvaluation: boolean
}): string {
  const { priceMin, priceMax, requiresEvaluation } = service

  if (requiresEvaluation) {
    return priceMin === null
      ? 'requiere evaluación previa'
      : `desde S/ ${priceMin} (requiere evaluación previa)`
  }
  if (priceMin === null) return 'precio no configurado'
  if (priceMax === null) return `desde S/ ${priceMin}`
  if (priceMin === priceMax) return `S/ ${priceMin}`
  return `S/ ${priceMin} a S/ ${priceMax}`
}
