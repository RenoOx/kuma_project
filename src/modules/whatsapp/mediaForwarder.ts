import { logger } from '@/config/logger.js'
import type { Appointment, Business, Customer } from '@/db/schema/index.js'
import { formatDateTimeForDisplay } from '@/shared/datetime.js'
import { AppError } from '@/shared/errors.js'
import { formatPersonName } from '@/shared/name.js'
import { err, ok, type Result } from '@/shared/result.js'
import type { WhatsappClient } from './baileys.client.js'
import type { ImagePurpose } from './imageExpectation.js'

// Same JID shape ownerNotifier builds. Kept local rather than imported so this
// module stays usable with any client, not only the registry-backed one.
function ownerJidFromPhone(phone: string): string {
  return `${phone.replace('+', '')}@s.whatsapp.net`
}

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
  customer: Pick<Customer, 'name' | 'phone'>
  image: Buffer
  caption: string | null
  /** Set when the customer has a request still waiting on the owner's call. */
  pendingAppointment: Pick<Appointment, 'service' | 'scheduledAt'> | null
  /** Set when this photo answers a request Emma made. */
  purpose: ImagePurpose | null
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
  customer: Pick<Customer, 'name' | 'phone'>
  timezone: string
  caption: string | null
  pendingAppointment: Pick<Appointment, 'service' | 'scheduledAt'> | null
  purpose: ImagePurpose | null
}): string {
  const who = formatPersonName(params.customer.name) ?? '(sin nombre)'
  const said = params.caption?.trim()

  const lines = ['📷 *Imagen del paciente*', '', `👤 ${who} (${params.customer.phone})`]

  if (params.pendingAppointment) {
    lines.push(
      `📋 Cita pendiente: ${params.pendingAppointment.service} — ${formatDateTimeForDisplay(
        params.pendingAppointment.scheduledAt,
        params.timezone,
      )}`,
    )
  }
  if (params.purpose) lines.push(`ℹ️ ${PURPOSE_LINE[params.purpose]}`)
  if (said) lines.push('', `💬 "${said}"`)

  lines.push('')
  if (params.pendingAppointment) {
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
 * the text-only path instead of leaving the photo nowhere.
 */
export async function forwardImageToOwner(params: ForwardImageParams): Promise<Result<void>> {
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
  const caption = buildOwnerCaption({
    customer: params.customer,
    timezone: business.timezone,
    caption: params.caption,
    pendingAppointment: params.pendingAppointment,
    purpose: params.purpose,
  })

  try {
    await params.client.sendImage(jid, params.image, caption)
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
    return ok(undefined)
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
