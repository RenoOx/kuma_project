import { logger } from '@/config/logger.js'
import type { Appointment, Business, Customer } from '@/db/schema/index.js'
import { formatDateTimeForDisplay } from '@/shared/datetime.js'
import { AppError } from '@/shared/errors.js'
import { appointmentName, formatPersonName } from '@/shared/name.js'
import { customerContactLabel } from '@/shared/phone.js'
import { err, ok, type Result } from '@/shared/result.js'
import type { WhatsappClient } from './baileys.client.js'
import type { ImagePurpose, PaymentContext } from './imageExpectation.js'
import { enqueueSend } from './sendQueue.js'

// Same JID shape ownerNotifier builds. Kept local rather than imported so this
// module stays usable with any client, not only the registry-backed one.
function ownerJidFromPhone(phone: string): string {
  return `${phone.replace('+', '')}@s.whatsapp.net`
}

// `waJid` opcional: con él, un cliente cuyo "teléfono" es su LID aparece como
// número oculto en vez de un +243… que no lleva a nadie.
type CaptionCustomer = Pick<Customer, 'name' | 'phone'> & { waJid?: string | null }

// Why the owner is seeing this photo at all. Without it they get a picture with
// no idea what triggered it, which is exactly the noise that makes an owner
// mute the bot.
const PURPOSE_LINE: Record<ImagePurpose, string> = {
  payment: 'Le pediste el comprobante de pago.',
  reference: 'Le pediste una foto de referencia.',
}

export interface ForwardImageParams {
  client: WhatsappClient
  business: Pick<Business, 'id' | 'timezone' | 'ownerWhatsappNumber'>
  customer: CaptionCustomer
  image: Buffer
  caption: string | null
  /** Set when the customer has a request still waiting on the owner's call. */
  pendingAppointment: Pick<Appointment, 'service' | 'scheduledAt' | 'customerName'> | null
  /** Set when this photo answers a request Emma made. */
  purpose: ImagePurpose | null
  /** Set when the deposit gate asked for this capture. */
  payment: PaymentContext | null
  /**
   * True when the booking is being withheld until the owner rules on this
   * capture — the deposit case. The card then has to say so out loud: the owner
   * used to read "respondé que sí y le confirmo la cita" about an appointment
   * that had already been created behind their back, so a "no" cost them a
   * cancellation instead of costing nothing.
   */
  awaitsVerification: boolean
  /**
   * El aviso ya armado para una foto que llegó en un paso con reenvío
   * configurado. Si viene, reemplaza al aviso de siempre.
   */
  stepCaption?: string
}

// Para comparar nombres sin que una tilde o una mayúscula cambien el resultado.
function normalizeName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Los servicios con los que Emma mandó un mensaje fijo, del más nuevo al más
 * viejo, sacados del argumento `service` de cada `send_fixed_message`.
 *
 * Es la señal más confiable de qué eligió el cliente: la tool solo acepta un
 * nombre que exista en el catálogo, y en un flujo armado con mensajes fijos (el
 * de Tecmin) ningún texto de Emma lo nombra — el nombre vive solo acá.
 * Tolerante: un `toolCalls` con otra forma o un JSON roto se saltea.
 */
export function fixedMessageServicesOf(
  messagesOldestFirst: ReadonlyArray<{ role: string; toolCalls: unknown }>,
): string[] {
  const out: string[] = []
  for (let i = messagesOldestFirst.length - 1; i >= 0; i--) {
    const message = messagesOldestFirst[i]
    if (message?.role !== 'assistant' || !Array.isArray(message.toolCalls)) continue
    // Dentro de un mismo mensaje también del último al primero: con beneficios +
    // descuento en la misma vuelta, el último es el más reciente.
    for (let j = message.toolCalls.length - 1; j >= 0; j--) {
      const service = fixedMessageServiceOf(message.toolCalls[j])
      if (service) out.push(service)
    }
  }
  return out
}

function fixedMessageServiceOf(call: unknown): string | null {
  if (typeof call !== 'object' || call === null) return null
  const fn = (call as { function?: unknown }).function
  if (typeof fn !== 'object' || fn === null) return null
  const { name, arguments: args } = fn as { name?: unknown; arguments?: unknown }
  if (name !== 'send_fixed_message' || typeof args !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(args)
    const service = (parsed as { service?: unknown } | null)?.service
    return typeof service === 'string' && service.trim() !== '' ? service : null
  } catch {
    return null
  }
}

/**
 * El servicio que eligió el cliente, buscado con reglas fijas y sin IA.
 *
 * En este orden, del dato más confiable al menos:
 * 1. Los servicios con que Emma mandó un mensaje fijo (`offered`, ver
 *    `fixedMessageServicesOf`): la tool ya los validó contra el catálogo.
 * 2. Lo que Emma guardó con save_customer_data (el valor que coincide con un
 *    nombre de servicio). Puede estar vacío: la foto del DNI puede llegar antes.
 * 3. Los mensajes de Emma, del más nuevo al más viejo: el primero que nombra UN
 *    solo servicio. Un mensaje que lista varios no dice cuál eligió.
 */
export function findChosenService<S extends { name: string }>(
  services: readonly S[],
  collected: Record<string, string>,
  assistantMessagesNewestFirst: readonly string[],
  offered: readonly string[] = [],
): S | null {
  const named = services
    .map((service) => ({ service, key: normalizeName(service.name) }))
    .filter((s) => s.key !== '')

  for (const value of [...offered, ...Object.values(collected)]) {
    const v = normalizeName(value)
    if (v.length < 3) continue
    const hit = named
      .filter((s) => v === s.key || v.includes(s.key) || s.key.includes(v))
      .sort((a, b) => b.key.length - a.key.length)[0]
    if (hit) return hit.service
  }

  for (const message of assistantMessagesNewestFirst) {
    const m = normalizeName(message)
    const mentioned = named.filter((s) => m.includes(s.key))
    if (mentioned.length === 1 && mentioned[0]) return mentioned[0].service
  }
  return null
}

const SUMMARY_MAX_LINES = 5
const SUMMARY_MAX_CHARS = 300

/**
 * El resumen recortado para el aviso: la descripción de un curso puede tener
 * diez viñetas, y el dueño solo necesita reconocer cuál es. Máximo 5 líneas (las
 * vacías no cuentan) y 300 caracteres — el tope de caracteres cubre una
 * descripción escrita como un solo párrafo largo. Si se corta, termina en "…".
 * La descripción del panel no cambia: esto es solo lo que va en el aviso.
 */
export function clampSummary(text: string): string {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  let out = lines.slice(0, SUMMARY_MAX_LINES).join('\n')
  let cut = lines.length > SUMMARY_MAX_LINES
  if (out.length > SUMMARY_MAX_CHARS) {
    const space = out.lastIndexOf(' ', SUMMARY_MAX_CHARS)
    out = out.slice(0, space > 0 ? space : SUMMARY_MAX_CHARS).trimEnd()
    cut = true
  }
  return cut ? `${out}…` : out
}

/**
 * El aviso al dueño cuando llega una foto en un paso con reenvío configurado.
 *
 * El resumen es la descripción del servicio elegido, copiada tal cual: el dueño
 * pidió que no la interprete nadie, así que el código la pega sin tocarla.
 */
export function buildStepImageCaption(params: {
  stepLabel: string
  customer: CaptionCustomer
  receivedAt: Date
  timezone: string
  summary: string | null
  said: string | null
  paused: boolean
  /**
   * Posición de esta foto en el grupo que mandó el cliente junto. Sin grupo (o
   * de a una), el aviso de siempre. En un grupo, la primera lleva el aviso
   * completo y las demás uno corto: repetir cliente, hora y resumen en cada
   * foto es ruido para el dueño y más texto saliente del número.
   */
  photo?: { index: number; total: number }
}): string {
  const who = formatPersonName(params.customer.name)
  const said = params.said?.trim()
  const photo = params.photo
  if (photo && photo.total > 1 && photo.index > 0) {
    const short = [
      `📷 Foto ${photo.index + 1} de ${photo.total} · ${who ?? customerContactLabel(params.customer)}`,
    ]
    if (said) short.push(`💬 "${said}"`)
    return short.join('\n')
  }
  const title =
    photo && photo.total > 1
      ? `📷 *${photo.total} fotos recibidas en «${params.stepLabel}»*`
      : `📷 *Foto recibida en «${params.stepLabel}»*`
  const lines = [
    title,
    '',
    who
      ? `👤 ${who} (${customerContactLabel(params.customer)})`
      : `👤 ${customerContactLabel(params.customer)}`,
    `🕒 ${formatDateTimeForDisplay(params.receivedAt, params.timezone)}`,
    params.summary?.trim()
      ? `📋 Resumen: ${clampSummary(params.summary)}`
      : '📋 Resumen: no se pudo identificar qué eligió',
  ]
  if (said) lines.push('', `💬 "${said}"`)
  lines.push('', params.paused ? 'El asistente quedó pausado en este chat.' : '¿Qué le respondo?')
  return lines.join('\n')
}

/**
 * Builds the caption the owner reads and relays the photo to their WhatsApp.
 *
 * The two shapes differ by what the owner can DO next: with a pending request
 * the photo is almost certainly the payment that unblocks it, so the card names
 * the appointment and the decisions available. Without one there is nothing to
 * approve, so it asks the only question left — what should Emma reply?
 */
export function buildOwnerCaption(params: {
  customer: CaptionCustomer
  timezone: string
  caption: string | null
  pendingAppointment: Pick<Appointment, 'service' | 'scheduledAt' | 'customerName'> | null
  purpose: ImagePurpose | null
  payment: PaymentContext | null
  awaitsVerification: boolean
}): string {
  const said = params.caption?.trim()
  const { payment } = params

  // Three sources, most specific first. Under the deposit gate `customer.name`
  // is still whatever WhatsApp put on the profile ("Rem"): the rename lives
  // inside bookAppointment, which only runs once the capture lands — after this
  // forward. The name the customer actually gave Emma rides in the payment
  // context, so it wins whenever there is one; failing that, a booking already
  // on file carries the name it was made under.
  const who = formatPersonName(
    payment
      ? payment.customerName
      : params.pendingAppointment
        ? appointmentName(params.pendingAppointment, params.customer)
        : params.customer.name,
  )

  const lines = [
    payment ? '💰 *Captura de pago recibida*' : '📷 *Imagen del cliente*',
    '',
    // No name worth showing is better than a push name the owner cannot place:
    // the phone is the one identifier that is always true.
    who
      ? `👤 ${who} (${customerContactLabel(params.customer)})`
      : `👤 ${customerContactLabel(params.customer)}`,
  ]

  if (params.pendingAppointment) {
    lines.push(
      `📋 Cita pendiente: ${params.pendingAppointment.service} — ${formatDateTimeForDisplay(
        params.pendingAppointment.scheduledAt,
        params.timezone,
      )}`,
    )
  } else if (payment) {
    // The booking does not exist yet — the deposit gate is holding it — so the
    // slot the customer asked for comes from the expectation instead.
    lines.push(
      `📋 Quiere agendar: ${payment.service} — ${formatDateTimeForDisplay(
        new Date(payment.scheduledAtISO),
        params.timezone,
      )}`,
    )
  }
  if (payment?.amount) lines.push(`💵 Adelanto pedido: ${payment.amount}`)
  if (params.purpose) lines.push(`ℹ️ ${PURPOSE_LINE[params.purpose]}`)
  if (said) lines.push('', `💬 "${said}"`)

  lines.push('')
  if (params.awaitsVerification) {
    lines.push(
      '⏳ *La cita todavía NO está creada.* Queda esperando tu visto bueno.',
      '',
      'Respondé *ok* y la agendo y le confirmo.',
      'Respondé *no se ve bien* y le pido que la reenvíe.',
    )
  } else if (payment) {
    lines.push(
      'Si el pago está bien, respondé que sí y le confirmo la cita.',
      'Si no se ve bien, decime y le pido que la reenvíe.',
    )
  } else if (params.pendingAppointment) {
    lines.push(
      '¿Es un comprobante de pago? Puedes:',
      '· Confirmar la cita',
      '· Pedirle que la reenvíe si no se ve bien',
      '· Responderle lo que necesites',
    )
  } else {
    lines.push('¿Qué le respondo?')
  }

  return lines.join('\n')
}

/**
 * Relays a customer's photo to the business owner.
 *
 * Returns err when the owner cannot be reached, so the caller can fall back to
 * the text-only path instead of leaving the photo nowhere. On success it hands
 * back the caption it built: the caller records that text in the owner thread,
 * and rebuilding it there would mean duplicating this module's formatting.
 */
export async function forwardImageToOwner(
  params: ForwardImageParams,
): Promise<Result<{ caption: string }>> {
  const { business } = params

  if (!business.ownerWhatsappNumber) {
    return err(
      new AppError({
        code: 'owner_not_configured',
        message: `business ${business.id} has no ownerWhatsappNumber`,
        userMessage: 'El negocio no tiene un número de dueño configurado.',
        logContext: { businessId: business.id },
      }),
    )
  }

  const jid = ownerJidFromPhone(business.ownerWhatsappNumber)
  const caption =
    params.stepCaption ??
    buildOwnerCaption({
      customer: params.customer,
      timezone: business.timezone,
      caption: params.caption,
      pendingAppointment: params.pendingAppointment,
      purpose: params.purpose,
      payment: params.payment,
      awaitsVerification: params.awaitsVerification,
    })

  try {
    await enqueueSend(business.id, 'owner', () =>
      params.client.sendImage(jid, params.image, caption),
    )
    logger.info(
      {
        businessId: business.id,
        jid,
        bytes: params.image.length,
        hasPendingAppointment: !!params.pendingAppointment,
        purpose: params.purpose,
      },
      'forwarded customer image to owner',
    )
    return ok({ caption })
  } catch (cause) {
    return err(
      new AppError({
        code: 'forward_image_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude reenviarle la imagen al dueño.',
        logContext: { businessId: business.id, jid },
        cause,
      }),
    )
  }
}
