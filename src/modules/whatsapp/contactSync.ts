import { logger } from '@/config/logger.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import * as customerService from '@/modules/customer/customer.service.js'
import { normalizeWaUsername } from '@/shared/phone.js'
import type { SyncedContact } from './baileys.client.js'

// El @usuario de un cliente sin número, cuando el celular del negocio lo
// sincroniza (al guardar o editar el contacto en su WhatsApp Business).
//
// Es la única fuente que no requiere consultarle a WhatsApp: el mensaje no lo
// trae (prueba en prod, 2026-10-05) y preguntarlo está descartado por riesgo de
// baneo. Lo guarda con la misma regla que el de un mensaje: si el mismo @usuario
// aparece en dos fichas del negocio, no se muestra en ninguna.

const log = logger.child({ component: 'whatsapp.contactSync' })

export async function recordSyncedContact(
  businessId: string,
  contact: SyncedContact,
): Promise<void> {
  const username = normalizeWaUsername(contact.username)
  if (!username) return

  const customer = await customerRepo.findByWaJid(businessId, contact.lid)
  if (!customer) {
    // El celular sincroniza todos sus contactos, no solo los clientes de Emma.
    log.info({ businessId, lid: contact.lid }, 'contact sync: no customer for this lid')
    return
  }

  const recorded = await customerService.recordWaUsername(businessId, customer, username)
  if (!recorded.ok) {
    log.warn(
      { businessId, customerId: customer.id, code: recorded.error.code },
      'contact sync: could not save username',
    )
    return
  }
  log.info(
    { businessId, customerId: customer.id, shown: recorded.data !== null },
    'contact sync: username saved',
  )
}
