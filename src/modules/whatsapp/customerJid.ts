import type { Customer } from '@/db/schema/index.js'

/**
 * The JID to address a customer at.
 *
 * Prefers the transport address WhatsApp actually delivered on, captured from
 * their last inbound message or call. Falls back to rebuilding the classic
 * `<digits>@s.whatsapp.net` shape from the phone.
 *
 * The fallback is not equivalent, it is a last resort: since the LID migration a
 * contact with no mutual history arrives as `<lid>@lid` and their stored "phone"
 * is the LID digits, so the rebuilt JID names an account that does not exist.
 * Sending there fails, and sending there repeatedly is a spam signal. It stays
 * because rows created before waJid existed have nothing else — those customers
 * heal on their next inbound message, and there is no backfill source for them
 * in the meantime.
 */
export function customerJid(customer: Pick<Customer, 'waJid' | 'phone'>): string {
  if (customer.waJid) return customer.waJid
  return `${customer.phone.replace('+', '')}@s.whatsapp.net`
}
