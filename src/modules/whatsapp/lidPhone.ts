import { logger } from '@/config/logger.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { jidUserOf, normalizePhone } from '@/shared/phone.js'
import { withTimeout } from '@/shared/withTimeout.js'

// El número real detrás de un `<lid>@lid`, cuando existe.
//
// Desde la migración LID, WhatsApp puede entregar un mensaje sin el número del
// remitente. Baileys guarda los pares LID↔número cada vez que WhatsApp se los da
// (en otro mensaje, al sincronizar historial o contactos) y los expone en
// `sock.signalRepository.lidMapping`. Solo se LEE por su API pública: no toca la
// sesión ni el envío.
//
// Si WhatsApp nunca entregó el par, nadie tiene el número. Con el dueño es
// distinto: su número ya lo sabemos, así que se le puede preguntar a WhatsApp qué
// LID le corresponde y comparar. Sin eso, el dueño de Tecmin entró por el flujo
// de cliente (2026-10-05).

const log = logger.child({ component: 'whatsapp.lidPhone' })

// Mismo criterio que LID_QUERY_TIMEOUT_MS en baileys.client.ts: corre dentro del
// candado del remitente, y una consulta colgada no puede frenar al cliente.
const LID_LOOKUP_TIMEOUT_MS = 10_000

// La consulta del LID del dueño es la única de este archivo que habla con
// WhatsApp. Un acierto lo guarda Baileys y no se repite; un fallo tampoco se
// reintenta hasta el próximo arranque del servidor: el dueño pidió que nada
// automático le haga consultas de más a WhatsApp (riesgo de baneo, 2026-10-05).
const ownerLookupFailed = new Set<string>()

/** `"51934833829:0@s.whatsapp.net"` → `"+51934833829"`. Null si no es un JID de teléfono. */
export function phoneOfPnJid(pn: string | null | undefined): string | null {
  if (!pn?.endsWith('@s.whatsapp.net')) return null
  const user = jidUserOf(pn)
  return user && /^\d+$/.test(user) ? `+${user}` : null
}

/** Lo que de Baileys usa este archivo; separado para poder probarlo sin socket. */
export interface LidLookup {
  getPNForLID(lid: string): Promise<string | null>
  getLIDForPN(pn: string): Promise<string | null>
}

/**
 * El número real de `jid`, o null si no se sabe (o `jid` no es un LID).
 *
 * Primero lo que Baileys ya tiene guardado (sin red); si no, si es el dueño.
 * Nunca falla: cualquier error o demora devuelve null y el mensaje sigue con los
 * dígitos del LID, como antes de este archivo.
 */
export async function resolveLidPhoneWith(
  lookup: LidLookup,
  businessId: string,
  jid: string,
  ownerPhone: string | null | undefined,
): Promise<string | null> {
  if (!jid.endsWith('@lid')) return null
  const lidUser = jidUserOf(jid)
  if (!lidUser) return null

  try {
    const pn = await withTimeout(lookup.getPNForLID(jid), LID_LOOKUP_TIMEOUT_MS, 'getPNForLID')
    const phone = phoneOfPnJid(pn)
    if (phone) return phone
  } catch (err) {
    log.warn({ err, businessId, jid }, 'getPNForLID failed')
  }

  const owner = normalizePhone(ownerPhone)
  if (!owner) return null
  if (ownerLookupFailed.has(businessId)) return null

  try {
    const ownerLid = await withTimeout(
      lookup.getLIDForPN(`${owner.slice(1)}@s.whatsapp.net`),
      LID_LOOKUP_TIMEOUT_MS,
      'getLIDForPN',
    )
    if (!ownerLid) {
      ownerLookupFailed.add(businessId)
      log.warn({ businessId }, 'owner LID not returned by WhatsApp — not retried until restart')
      return null
    }
    return jidUserOf(ownerLid) === lidUser ? owner : null
  } catch (err) {
    ownerLookupFailed.add(businessId)
    log.warn({ err, businessId }, 'getLIDForPN for owner failed — not retried until restart')
    return null
  }
}

/** `resolveLidPhoneWith` sobre el socket conectado del negocio. Sin socket, null. */
export function resolveLidPhone(
  businessId: string,
  jid: string,
  ownerPhone: string | null | undefined,
): Promise<string | null> {
  const lookup = lidLookupFor(businessId)
  if (!lookup) return Promise.resolve(null)
  return resolveLidPhoneWith(lookup, businessId, jid, ownerPhone)
}

/** El traductor de Baileys del negocio, o null si no hay socket. */
export function lidLookupFor(businessId: string): LidLookup | null {
  return clientRegistry.getClient(businessId)?.sock.signalRepository.lidMapping ?? null
}
