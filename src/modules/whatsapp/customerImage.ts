import type { logger } from '@/config/logger.js'
import type { Business, Customer } from '@/db/schema/index.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { activeServices } from '@/modules/business/business.settings.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import { fileConfigFor } from '@/modules/conversation/flowSource.js'
import { blueprintFor } from '@/modules/conversation/nodeCatalog.js'
import type { ImageHandling } from '@/modules/conversation/nodes/types.js'
import * as customerService from '@/modules/customer/customer.service.js'
import * as eventsRepo from '@/modules/events/events.repo.js'
import * as messageService from '@/modules/message/message.service.js'
import * as tagService from '@/modules/tag/tag.service.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import * as mediaForwarder from '@/modules/whatsapp/mediaForwarder.js'
import { customerFindHints, isLidPhone, waUsernameOf } from '@/shared/phone.js'

// Qué se hace con una foto de un cliente, separado del envío por WhatsApp.
//
// Lo usan el handler (la foto real) y el simulador del panel (una foto de
// prueba). Que las dos decidan con las MISMAS funciones es la razón de este
// archivo: si el simulador tuviera su propia copia de la regla, una prueba que
// pasa ahí no diría nada de lo que pasa en WhatsApp.

type ImageLogger = Pick<typeof logger, 'info' | 'warn' | 'error'>

// Lo que lee el modelo cuando una foto llega en un paso que no la pide, en un
// negocio con `earlyImages: 'continue'`. Va como mensaje del cliente, igual que
// las marcas de pago: el modelo nunca ve la foto, y sin esto no sabría que llegó.
export const EARLY_IMAGE_MARKER =
  '[El cliente mandó una foto antes de que se la pidieras. No la ves y NO se le reenvió a nadie. Esto NO es una respuesta a tu última pregunta: no es un sí ni un no. No digas que la recibiste ni que la revisaste, y no pidas datos ni pagos con tus palabras: seguí el paso actual normalmente, y cuando corresponda pedir el pago o el DNI, pedile que la vuelva a mandar en ese momento.]'

/**
 * El primer corte (regla del negocio, 2026-09-28): una foto se atiende solo si
 * el paso pide requisitos o pagos (`onImage`) o si hay un pago esperado, una
 * cita pendiente o adelanto (`wanted`). Fuera de eso, silencio — salvo un
 * negocio con `earlyImages: 'continue'`, donde Emma sigue el paso sabiendo que
 * llegó (Tecmin, 2026-09-30: el DNI llegaba junto con el "sí" y nadie respondía).
 */
export function decideCustomerImage(params: {
  onImage: ImageHandling | undefined
  wanted: boolean
  earlyImages: 'continue' | undefined
}): 'handle' | 'continue_with_llm' | 'ignore' {
  if (params.onImage || params.wanted) return 'handle'
  return params.earlyImages === 'continue' ? 'continue_with_llm' : 'ignore'
}

/**
 * Si Emma se pausa con esta foto. Si el paso también pedía reenviar y el
 * reenvío falló, NO: el dueño no se enteró de nada y el cliente quedaría
 * hablándole a nadie.
 */
export function shouldPauseAfterImage(
  onImage: ImageHandling | undefined,
  forwarded: boolean,
): boolean {
  return onImage?.pause === true && (!onImage.forward || forwarded)
}

/**
 * Apaga a Emma en este chat con el mismo interruptor que usa el Inbox, deja el
 * evento que cuenta el embudo y marca el chat "Por validar". Devuelve si la
 * etiqueta quedó puesta.
 *
 * La etiqueta no puede costar la pausa: si falla —por ejemplo, el negocio ya
 * tiene 10 etiquetas— solo se loguea.
 */
export async function pauseOnImage(params: {
  businessId: string
  conversationId: string
  state: string | null
  photos: number
  log: ImageLogger
}): Promise<{ paused: boolean; tagged: boolean }> {
  const { businessId, conversationId, state, photos, log } = params
  try {
    await conversationRepo.setEmmaEnabled(businessId, conversationId, false)
    await eventsRepo.create({
      businessId,
      conversationId,
      type: 'emma_paused_on_image',
      payload: { state, photos },
    })
    log.info({ conversationId, state, photos }, 'emma paused after customer image')

    const marked = await tagService.markPendingValidation(businessId, conversationId)
    if (!marked.ok) {
      log.warn(
        { code: marked.error.code, conversationId },
        'could not tag the conversation as pending validation',
      )
    }
    return { paused: true, tagged: marked.ok }
  } catch (err) {
    log.error({ err, conversationId }, 'failed to pause emma after customer image')
    return { paused: false, tagged: false }
  }
}

/**
 * El aviso al dueño para una foto que llegó en un paso con reenvío configurado.
 *
 * El resumen es la descripción del servicio elegido, sin pasar por el modelo. Si
 * leer el historial falla, el aviso sale igual, sin resumen: la foto le tiene
 * que llegar al dueño aunque falte ese dato.
 */
export async function buildStepImageNotice(params: {
  business: Business
  settings: BusinessSettings | null
  customer: Customer
  conversationId: string
  state: string
  caption: string | null
  paused: boolean
  /** Posición de la foto en el grupo que mandó el cliente junto, si vino en uno. */
  photo?: { index: number; total: number }
  log: ImageLogger
}): Promise<string> {
  const { business, settings, customer, conversationId, state, log } = params

  let assistantTexts: string[] = []
  let offered: string[] = []
  const history = await messageService.getRecentHistory(business.id, conversationId, 20)
  if (history.ok) {
    assistantTexts = history.data
      .filter((m) => m.role === 'assistant' && m.content.trim() !== '')
      .map((m) => m.content)
      .reverse()
    // El nombre exacto de lo que eligió vive en los send_fixed_message: en un
    // flujo armado con mensajes fijos ningún texto de Emma lo nombra.
    offered = mediaForwarder.fixedMessageServicesOf(history.data)
  } else {
    log.warn({ code: history.error.code }, 'could not read history for the image notice')
  }

  const chosen = settings
    ? mediaForwarder.findChosenService(
        activeServices(settings),
        customerService.collectedDataOf(customer),
        assistantTexts,
        offered,
      )
    : null

  // Sin número ni @usuario, el dueño necesita otra forma de encontrar el chat en
  // su WhatsApp Business: la etiqueta de lo que eligió y una frase para la lupa.
  const label = await labelRequirementChat({
    business,
    customer,
    serviceId: chosen?.id,
    // En un grupo de fotos, una sola vez: las demás no repiten la escritura.
    first: (params.photo?.index ?? 0) === 0,
    log,
  })
  const lastText = history.ok ? lastCustomerTextOf(history.data) : null

  return mediaForwarder.buildStepImageCaption({
    stepLabel: blueprintFor(state, settings?.flowType ?? 'appointments')?.label ?? state,
    customer,
    receivedAt: new Date(),
    timezone: business.timezone,
    // Sin descripción cargada, el nombre: sigue siendo lo que eligió, tal cual.
    summary: chosen?.description ?? chosen?.name ?? null,
    said: params.caption,
    paused: params.paused,
    ...(params.photo ? { photo: params.photo } : {}),
    findHints: customerFindHints(customer, { label, lastText }),
  })
}

/**
 * Le pone al chat la etiqueta del WhatsApp Business que corresponde a lo que el
 * cliente eligió (`whatsappLabels` del archivo del negocio). Solo si no hay
 * número ni @usuario: con esos el dueño ya lo encuentra (prioridad del dueño,
 * 2026-10-05). Devuelve el nombre de la etiqueta si quedó puesta, para que el
 * aviso lo diga; si falla, null y el aviso sale igual.
 */
async function labelRequirementChat(params: {
  business: Business
  customer: Customer
  serviceId: string | undefined
  first: boolean
  log: ImageLogger
}): Promise<string | null> {
  const { business, customer, serviceId, log } = params
  if (!params.first || !serviceId || !customer.waJid) return null
  if (!isLidPhone(customer.phone, customer.waJid) || waUsernameOf(customer.metadata)) return null
  const label = fileConfigFor(business.id)?.whatsappLabels?.[serviceId]
  if (!label) return null
  const client = clientRegistry.getClient(business.id)
  if (!client) return null
  try {
    await client.labelChat(customer.waJid, label)
    return label.name
  } catch (err) {
    log.warn({ err, labelId: label.id }, 'could not label the chat in WhatsApp Business')
    return null
  }
}

/**
 * Lo último que el cliente escribió en texto, para que el dueño lo busque con la
 * lupa. Salta las marcas internas de fotos y formatos ("[El cliente envió…]") y
 * le saca a un mensaje citado el "[Sobre: …]" que le agrega el handler.
 * `history` viene del más viejo al más nuevo (`getRecentHistory`).
 */
function lastCustomerTextOf(history: Array<{ role: string; content: string }>): string | null {
  for (const message of [...history].reverse()) {
    if (message.role !== 'user') continue
    const text = message.content.replace(/^\[Sobre: "[^"]*"\]\s*/, '').trim()
    if (text !== '' && !text.startsWith('[')) return text
  }
  return null
}
