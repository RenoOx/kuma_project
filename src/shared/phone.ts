/**
 * Phone numbers reach this system in two shapes, and the difference is easy to
 * miss by eye:
 *
 *   - `extractPhone` (whatsapp/handler) always builds "+51987654321" from an
 *     inbound JID — the leading "+" is not optional there.
 *   - The admin panel's own placeholder tells operators to type "51987654321",
 *     without it, so that is what most rows in the database look like.
 *
 * A strict `===` between those two is false, which silently routed business
 * owners into the CUSTOMER flow: Emma answered her own boss as if he were a
 * patient ("no tengo acceso a las citas, contacta al consultorio"). The bug hid
 * for a while because every OUTBOUND path strips the "+" before building a JID,
 * so the owner kept receiving notifications and only failed to be recognised
 * when he wrote back.
 *
 * Anything that compares or stores a phone goes through here.
 */

/** Digits only, prefixed with "+". Null for input carrying no digits at all. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  return digits.length === 0 ? null : `+${digits}`
}

/**
 * Un número de prueba: un negocio (o un cliente del simulador) que nunca tiene
 * WhatsApp. El arranque no le levanta sesión y "Conectar" se niega.
 *
 * +999 no es un código de país asignado. Se exigen 9 dígitos o más después del
 * prefijo porque un celular peruano cargado sin +51 puede empezar con 999
 * ("999 123 456" → +999123456, 9 dígitos en total) y eso NO es un número de
 * prueba: es un error de carga que tiene que seguir viéndose como tal.
 */
export function isSandboxNumber(raw: string | null | undefined): boolean {
  const normalized = normalizePhone(raw)
  return normalized !== null && /^\+999\d{9,}$/.test(normalized)
}

/**
 * True when both values denote the same number, whatever shape each arrived in.
 *
 * Null/empty never matches — "no owner configured" must not compare equal to
 * "no phone extracted", or an unparsable JID would be greeted as the owner.
 */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const normalizedA = normalizePhone(a)
  return normalizedA !== null && normalizedA === normalizePhone(b)
}

/**
 * Lo que va antes del "@" (y del ":dispositivo") en un JID: `"123:5@lid"` → `"123"`.
 * Null si no tiene forma de JID.
 */
export function jidUserOf(jid: string | null | undefined): string | null {
  if (!jid) return null
  const at = jid.indexOf('@')
  if (at <= 0) return null
  const user = jid.slice(0, at).split(':')[0]
  return user ? user : null
}

/**
 * True cuando el "teléfono" guardado son en realidad los dígitos del LID de su JID.
 *
 * Desde la migración LID, WhatsApp puede entregar un contacto como `<lid>@lid` sin
 * su número, y `extractPhone` usa esos dígitos como teléfono para que la ficha
 * tenga una clave estable. Sirven para reconocerlo, no para llamarlo: +243… en el
 * panel parece un número del Congo y no lleva a nadie (Tecmin, 2026-10-05).
 */
export function isLidPhone(
  phone: string | null | undefined,
  waJid: string | null | undefined,
): boolean {
  if (!waJid?.endsWith('@lid')) return false
  const user = jidUserOf(waJid)
  return user !== null && normalizePhone(phone) === `+${user}`
}

/** El @usuario de WhatsApp guardado en `customers.metadata` (sin "@"), o null. */
export function waUsernameOf(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const value = (metadata as Record<string, unknown>).waUsername
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** El @usuario que trajo el último mensaje (aunque no se muestre), o null. */
export function waUsernameSeenOf(metadata: unknown): string | null {
  if (typeof metadata !== 'object' || metadata === null) return null
  const value = (metadata as Record<string, unknown>).waUsernameSeen
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Un @usuario de WhatsApp limpio (sin "@"), o null si no tiene esa forma.
 *
 * Viene del mensaje (`remoteJidUsername`), o sea de afuera: se exige la forma de
 * un usuario (letras, números, punto y guion bajo) antes de mostrarlo en un aviso.
 */
export function normalizeWaUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().replace(/^@/, '')
  return /^[A-Za-z0-9._]{1,35}$/.test(value) ? value : null
}

/**
 * Cómo se nombra al cliente en un aviso al dueño, por prioridad (decisión del
 * dueño, 2026-10-05): 1. su número (con su @usuario al lado si lo hay); 2. su
 * @usuario de WhatsApp; 3. "sin número".
 *
 * Sin número no se muestra el ID del LID (decisión del dueño, 2026-10-06: no
 * le sirve). Costo conocido: `reply_to_customer` del asistente del dueño busca
 * la ficha por lo que dice el aviso, y sin número ni ID no la encuentra. En
 * Tecmin el asistente está apagado (`ownerAssistant: false`).
 */
export function customerContactLabel(customer: {
  phone: string
  waJid?: string | null
  metadata?: unknown
}): string {
  const username = waUsernameOf(customer.metadata)
  if (!isLidPhone(customer.phone, customer.waJid)) {
    return username ? `${customer.phone} · @${username}` : customer.phone
  }
  return username ? `@${username}` : 'sin número'
}

// Lo justo para buscarlo con la lupa de WhatsApp: una frase, no el mensaje entero.
const LAST_TEXT_MAX = 45

/**
 * Las líneas que le dicen al dueño cómo encontrar al cliente en el WhatsApp
 * Business de su celular, cuando no hay número. Con número, ninguna: el número
 * ya alcanza.
 *
 * - Con @usuario: buscarlo por ese @usuario (es único).
 * - Sin @usuario: la etiqueta que Emma le puso al chat, si se la puso, y una frase
 *   de su último mensaje para buscarla con la lupa.
 */
export function customerFindHints(
  customer: { phone: string; waJid?: string | null; metadata?: unknown },
  extra: { label?: string | null; lastText?: string | null } = {},
): string[] {
  if (!isLidPhone(customer.phone, customer.waJid)) return []
  const username = waUsernameOf(customer.metadata)
  if (username) return [`🔎 Búscalo en tu WA Business como @${username}`]
  const lines: string[] = []
  if (extra.label) lines.push(`🏷️ En tu WA Business: «${extra.label}»`)
  const text = extra.lastText?.replace(/\s+/g, ' ').trim()
  if (text) {
    const clipped =
      text.length <= LAST_TEXT_MAX
        ? text
        : `${text.slice(0, text.lastIndexOf(' ', LAST_TEXT_MAX) + 1 || LAST_TEXT_MAX).trim()}…`
    lines.push(`💬 Su último mensaje: "${clipped}"`)
  }
  return lines
}
