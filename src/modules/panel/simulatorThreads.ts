import { type AnyColumn, type SQL, sql } from 'drizzle-orm'
import { conversations, customers } from '@/db/schema/index.js'

// Las conversaciones del simulador (pestaña "Pruebas") quedan en la base —son
// conversaciones de verdad, con su historial y sus etiquetas— pero no son
// clientes: el panel no las lista ni las cuenta en el Inbox, Contactos, el
// Dashboard ni el embudo (decisión del 2026-10-26, al prender las pruebas en
// prod). Solo se ven dentro de Pruebas.
//
// Se reconocen por el teléfono del cliente de prueba que arma simulator.service
// (+999 y los 9 dígitos de la sesión). +999 no es un código de país asignado: un
// cliente real nunca lo tiene. Si el prefijo cambia allá, cambia acá.
const SIMULATOR_PHONE_PATTERN = '^\\+999[0-9]{9}$'

/**
 * Para un WHERE sobre `conversations`: un hilo de un cliente real (ni el del
 * dueño ni uno del simulador). El cliente se busca en el mismo negocio que la
 * conversación.
 */
export const REAL_CUSTOMER_THREAD: SQL = sql`(${conversations.type} = 'customer' and not exists (
  select 1 from ${customers} sim
  where sim.id = ${conversations.customerId}
    and sim.business_id = ${conversations.businessId}
    and sim.phone ~ ${SIMULATOR_PHONE_PATTERN}
))`

/** Para un WHERE sobre `customers`: no es un cliente de prueba. */
export const REAL_CUSTOMER: SQL = sql`${customers.phone} !~ ${SIMULATOR_PHONE_PATTERN}`

/**
 * Para filas que apuntan a una conversación (eventos, mensajes): no es de una
 * conversación del simulador. Una fila sin conversación se queda.
 */
export function outsideSimulator(conversationId: AnyColumn): SQL {
  return sql`not exists (
    select 1 from ${conversations} sim_conv
    join ${customers} sim on sim.id = sim_conv.customer_id and sim.business_id = sim_conv.business_id
    where sim_conv.id = ${conversationId}
      and sim.phone ~ ${SIMULATOR_PHONE_PATTERN}
  )`
}
