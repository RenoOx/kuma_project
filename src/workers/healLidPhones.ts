import { logger } from '@/config/logger.js'
import * as customerRepo from '@/modules/customer/customer.repo.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { lidLookupFor, phoneOfPnJid } from '@/modules/whatsapp/lidPhone.js'
import { isLidPhone } from '@/shared/phone.js'

// Corrige las fichas guardadas con los dígitos de su LID en vez de su número.
//
// Baileys aprende pares LID↔número después de que el cliente escribió (al
// sincronizar historial o contactos, o en otro mensaje). Sin este barrido, la
// ficha seguía mostrando "+243…" hasta que el cliente volviera a escribir.
//
// Solo lee lo que Baileys ya tiene guardado (`getPNForLID`, sin red): no le hace
// ninguna consulta a WhatsApp, así que correrlo seguido no suma tráfico al
// número. Recorre solo los negocios con socket en este proceso, y cada ficha se
// lee y se escribe bajo el mismo businessId.

const log = logger.child({ component: 'worker.healLidPhones' })

export interface HealLidPhonesResult {
  checked: number
  healed: number
}

export async function healLidPhones(): Promise<HealLidPhonesResult> {
  const result: HealLidPhonesResult = { checked: 0, healed: 0 }

  for (const [businessId] of clientRegistry.getAllClients()) {
    const lookup = lidLookupFor(businessId)
    if (!lookup) continue

    const candidates = (await customerRepo.listWithLidJid(businessId)).filter((c) =>
      isLidPhone(c.phone, c.waJid),
    )
    for (const customer of candidates) {
      if (!customer.waJid) continue
      result.checked++
      try {
        const phone = phoneOfPnJid(await lookup.getPNForLID(customer.waJid))
        if (!phone) continue

        // UNIQUE (business_id, phone): si ya hay una ficha con el número real,
        // es la misma persona escribiendo antes por otra vía. Unir dos fichas
        // (conversaciones, citas, etiquetas) no se decide solo; queda en el log.
        const other = await customerRepo.findByPhone(businessId, phone)
        if (other) {
          log.warn(
            { businessId, customerId: customer.id, otherCustomerId: other.id },
            'lid customer has a real phone that another customer already uses — left as is',
          )
          continue
        }

        await customerRepo.updatePhone(businessId, customer.id, phone)
        result.healed++
        log.info({ businessId, customerId: customer.id }, 'lid customer phone healed')
      } catch (err) {
        log.warn({ err, businessId, customerId: customer.id }, 'heal lid phone failed')
      }
    }
  }

  return result
}

// Mismo guard que los otros workers: una corrida que dura más que el intervalo
// no compite con otra copia de sí misma.
let running = false

export async function healLidPhonesGuarded(): Promise<void> {
  if (running) {
    log.warn('heal lid phones still running from a previous tick — skipping this one')
    return
  }
  running = true
  try {
    const result = await healLidPhones()
    if (result.checked > 0) log.info(result, 'heal lid phones run complete')
  } finally {
    running = false
  }
}
