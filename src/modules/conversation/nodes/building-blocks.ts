import type { ExitTarget, NodeBlueprint } from './types.js'

// Pieces more than one node file uses. Nothing here belongs to a flow type: if
// it only makes sense for appointments or for sales, it goes in that file.

// Tool name constants, so a rename breaks the build here rather than silently
// offering a tool the executor does not know.
export const ESCALATE = 'escalate_to_human'
export const PENDING_CONFIRM = 'confirm_pending_appointment'
export const SERVICE_MEDIA = 'send_service_media'
export const CHECK_AVAILABILITY = 'check_availability'
export const BOOK = 'book_appointment'
export const REQUEST_IMAGE = 'request_image'
export const SHOW_SERVICES = 'show_services'
export const SAVE_DATA = 'save_customer_data'
export const CONFIRM_SUMMARY = 'confirm_summary'
export const CORRECT_FIELD = 'correct_field'
/**
 * The one generic emitter.
 *
 * Every other exit in this catalogue fires because a specific thing happened —
 * a booking was made, a capture arrived, the owner approved. That is what keeps
 * `validateFlow`'s promise honest, and it is also why an owner could never add a
 * route of their own: there was no code path to fire it.
 *
 * This tool is that code path. The owner writes the CONDITION in their own words
 * and the model decides whether it holds; the executor checks the branch it
 * named against the ones the step actually declares. So the trigger still has a
 * real emitter and the target is still one the compiler resolved — the guarantee
 * survives, and the owner gets to draw the route.
 */
export const ADVANCE_FLOW = 'advance_flow'

/**
 * Manda un mensaje fijo del negocio tal cual. Como advance_flow, no lo declara
 * ningún nodo: lo recibe un paso cuando el archivo del negocio le asigna mensajes
 * fijos, así nunca se ofrece una herramienta sin nada que mandar.
 */
export const SEND_FIXED_MESSAGE = 'send_fixed_message'

export const to = (node: string): ExitTarget => ({ node })

/**
 * Keeps the node's id as a literal type, so an array of nodes knows exactly
 * which ids it holds. That is what lets a per-business config file be told at
 * compile time that a clinic has no `collect_data`.
 */
export function defineNode<const Id extends string>(
  blueprint: NodeBlueprint & { id: Id },
): NodeBlueprint & { id: Id } {
  return blueprint
}

/**
 * Shared by the two nodes that put services in front of a customer.
 *
 * The distinction it draws — catalogue versus detail — is the one CLAUDE.md
 * already documents and the prompt body already states. What was missing was
 * having it in the node block, which is the last thing the model reads and
 * therefore the thing it follows when the two disagree.
 */
export const MEDIA_STEP =
  'Si nombrás UN servicio con su detalle —porque lo pidió o porque se lo estás recomendando— y ese servicio está marcado [con material], mandá el material en este mismo turno. Listar el catálogo no cuenta: ahí van solo nombre y precio.'

/**
 * Both nodes that put services in front of a customer have to ASK for them.
 *
 * It lived only in listado_servicios, and that node is reached BY calling
 * show_services — the instruction sat behind the door it was meant to open. The
 * first listing of a conversation happens in `informing`, which had the tool and
 * no reason to use it, so no cards went out and the filter was never enforced.
 */
export const SHOW_SERVICES_STEP =
  'Cuando vayas a nombrar servicios, llamá show_services con la categoría o los servicios que correspondan a lo que pidió el cliente. Te devuelve cuáles son y manda sola la ficha de cada uno. No los listes de memoria.'
