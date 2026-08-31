import { downloadMediaMessage, type WAMessage } from '@whiskeysockets/baileys'
import { env } from '@/config/env.js'
import { logger } from '@/config/logger.js'
import type { Appointment, Business, Customer } from '@/db/schema/index.js'
import * as appointmentRepo from '@/modules/appointment/appointment.repo.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as businessService from '@/modules/business/business.service.js'
import { shouldForwardImages } from '@/modules/business/business.settings.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as customerService from '@/modules/customer/customer.service.js'
import * as demoService from '@/modules/demo/demo.service.js'
import * as eventsRepo from '@/modules/events/events.repo.js'
import * as llmService from '@/modules/llm/llm.service.js'
import * as messageService from '@/modules/message/message.service.js'
import * as ownerAssistantService from '@/modules/ownerAssistant/ownerAssistant.service.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import {
  consumeImageExpectation,
  type ImagePurpose,
  type PaymentContext,
} from '@/modules/whatsapp/imageExpectation.js'
import * as mediaForwarder from '@/modules/whatsapp/mediaForwarder.js'
import { bufferMessage } from '@/modules/whatsapp/messageBuffer.js'
import {
  classifyIncoming,
  describeFormat,
  IMAGE_FORWARDED_REPLY,
  IMAGE_RECEIVED_REPLY,
  PAYMENT_BOOKED_CONFIRMED_REPLY,
  PAYMENT_BOOKED_PENDING_REPLY,
  PAYMENT_IMAGE_REPLY,
  replyForFormat,
  type UnsupportedFormat,
} from '@/modules/whatsapp/messageKind.js'
import { sendWithPresence } from '@/modules/whatsapp/outbound.js'
import * as ownerNotifier from '@/modules/whatsapp/ownerNotifier.js'
import { formatPersonName } from '@/shared/name.js'
import { samePhone } from '@/shared/phone.js'

const LLM_FALLBACK_REPLY =
  'Mmm, algo no salió bien de mi lado. Intenta de nuevo en un momento, ¿va?'

const PAUSED_REPLY =
  'En este momento no podemos atenderte automáticamente. Un asesor te contactará pronto.'

// Sent when ownerAssistantService.handle itself fails — the owner never sees the
// model's voice in that case, so this string has to carry the same warmth the
// prompt asks for. It is NOT a "no puedo hacer eso": it means something broke.
const OWNER_FALLBACK_REPLY = 'Uy, no pude completar eso 😅 ¿Lo intentamos de nuevo?'

const ESCALATED_REPLY = 'Ya avisé al encargado, te escribirá en breve 😊'

export type SendFn = (jid: string, text: string) => Promise<void>

// Structural subset of the Pino logger, so helpers accept a child logger
// without fighting Pino's generics over custom-level type parameters.
type HandlerLogger = Pick<typeof logger, 'info' | 'warn' | 'error'>

// ── Anti-ban layer ───────────────────────────────
// Este número pertenece al cliente. Un baneo de
// Meta durante el trial destruye la confianza y
// el contrato. Tres reglas no negociables:
// 1. humanDelay() antes de toda respuesta al cliente
// 2. sendPresenceUpdate composing → paused siempre
// 3. NUNCA usar este número para mensajes masivos,
//    campañas, broadcasts ni listas de difusión.
//    500 mensajes en un minuto = baneo inmediato.
// ────────────────────────────────────────────────

// sendWithPresence moved to whatsapp/outbound.ts so the owner assistant can
// use it without closing an import cycle through this file. Re-exported here
// because callHandler.ts and the tests already import it from this module.
export { sendWithPresence }

// Converts any stray Markdown that GPT produces into WhatsApp-native formatting.
// Acts as a hard backstop so the prompt rules never reach the customer as
// literal asterisks or hyphens even if the model ignores the formatting section.
function sanitizeForWhatsApp(text: string): string {
  return (
    text
      // **bold** → *bold*  (double asterisk Markdown → single asterisk WA bold)
      .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
      // ## Heading → Heading  (strip Markdown headings)
      .replace(/^#{1,6}\s+/gm, '')
      // "- item" at line start → "· item"
      .replace(/^- /gm, '· ')
  )
}

// Drops repeat deliveries of a message we already accepted.
//
// The sender lock below serialises work but does NOT deduplicate it: a second
// `messages.upsert` carrying the same key.id chains onto the lock and runs the
// whole pipeline again, which reached the customer as two identical replies a
// few seconds apart. Baileys re-delivers on reconnects and on the first message
// of a new chat, so identity has to be checked before any work is queued.
//
// Keyed by businessId + message id: ids come from WhatsApp and two tenants must
// never be able to silence each other's messages.
//
// A Map rather than a Set because entries need to expire — an unbounded set of
// every id ever seen is a leak in a long-lived process. In-memory on purpose:
// after a deploy the window resets, and the cost is one possible duplicate.
const PROCESSED_MESSAGE_TTL_MS = 60 * 1000
const PROCESSED_IDS_PRUNE_THRESHOLD = 1000
const processedMessageIds = new Map<string, number>()

/**
 * Marks a message id as seen and reports whether it is a repeat.
 *
 * Must be called from synchronous code (it is, in handleIncomingMessage): with
 * no await between the read and the write, check-and-set is atomic against the
 * event loop, so two upserts in the same tick cannot both pass.
 */
function claimMessageId(key: string, now: number = Date.now()): boolean {
  const seenAt = processedMessageIds.get(key)
  if (seenAt !== undefined && now - seenAt < PROCESSED_MESSAGE_TTL_MS) return false

  if (processedMessageIds.size > PROCESSED_IDS_PRUNE_THRESHOLD) {
    for (const [k, t] of processedMessageIds) {
      if (now - t >= PROCESSED_MESSAGE_TTL_MS) processedMessageIds.delete(k)
    }
  }

  processedMessageIds.set(key, now)
  return true
}

// Serialises message processing per (businessId, sender-phone) so that two
// rapid messages from the same number never run their LLM calls concurrently,
// which would interleave messages in the conversation history.
const senderLocks = new Map<string, Promise<void>>()

function withSenderLock(key: string, work: () => Promise<void>): Promise<void> {
  const prev = senderLocks.get(key) ?? Promise.resolve()
  const next = prev.then(work, work)
  senderLocks.set(key, next)
  void next.finally(() => {
    if (senderLocks.get(key) === next) senderLocks.delete(key)
  })
  return next
}

// Sending the "text only" notice once per media is helpful; sending it after
// each of five voice notes is noise, and repeated identical outbound messages
// are exactly the pattern WhatsApp flags. In-memory on purpose: unlike the
// anti-ban guard, a reset after a deploy costs one extra polite message.
const UNSUPPORTED_NOTICE_COOLDOWN_MS = 10 * 60 * 1000
const unsupportedNoticeSentAt = new Map<string, number>()

function shouldSendUnsupportedNotice(conversationId: string): boolean {
  const last = unsupportedNoticeSentAt.get(conversationId)
  const now = Date.now()
  if (last !== undefined && now - last < UNSUPPORTED_NOTICE_COOLDOWN_MS) return false
  unsupportedNoticeSentAt.set(conversationId, now)
  return true
}

// Once a conversation is escalated a human owes it an answer, so the bot goes
// quiet instead of talking over them. The customer still gets one "someone is
// coming" line per hour — silence after every message would read as a hang.
// In-memory like the notice cooldown above: a deploy costs one extra polite
// message, which is cheaper than a table.
const ESCALATED_NOTICE_COOLDOWN_MS = 60 * 60 * 1000
const escalatedNoticeSentAt = new Map<string, number>()

function shouldSendEscalatedNotice(conversationId: string): boolean {
  const last = escalatedNoticeSentAt.get(conversationId)
  const now = Date.now()
  if (last !== undefined && now - last < ESCALATED_NOTICE_COOLDOWN_MS) return false
  escalatedNoticeSentAt.set(conversationId, now)
  return true
}

// Recorded for every unreadable message, including while the bot is paused, so
// the frequency of these is measurable regardless of whether we replied.
async function recordUnsupportedEvent(
  businessId: string,
  conversationId: string,
  // Images left UnsupportedFormat when forwarding arrived, but they still earn
  // an audit row: "how many photos does this business get" is the number that
  // tells us whether forwarding is worth keeping.
  format: UnsupportedFormat | 'image',
  phone: string,
  log: HandlerLogger,
): Promise<void> {
  try {
    await eventsRepo.create({
      businessId,
      conversationId,
      type: 'unsupported_media',
      payload: { format, phone },
    })
  } catch (err) {
    log.error({ err, format }, 'failed to record unsupported_media event')
  }
}

// Acknowledges an unreadable message — the "text only" notice for most
// formats, a photo-specific line for images — subject to the cooldown.
//
// `humanize` carries the anti-ban timing and MUST be true for customers and
// false for the owner: this helper serves both flows, and the owner poking their
// own bot should not sit through a fake 4.5s of typing.
async function respondUnsupportedFormat(params: {
  businessId: string
  conversationId: string
  format: UnsupportedFormat | 'image'
  jid: string
  send: SendFn
  log: HandlerLogger
  humanize: boolean
}): Promise<void> {
  const { businessId, conversationId, format, jid, send, log, humanize } = params

  if (!shouldSendUnsupportedNotice(conversationId)) {
    log.info({ conversationId, format }, 'unsupported format within cooldown; event only')
    return
  }

  const reply = format === 'image' ? IMAGE_RECEIVED_REPLY : replyForFormat(format)
  const persisted = await messageService.append({
    businessId,
    conversationId,
    role: 'assistant',
    content: reply,
  })
  if (!persisted.ok) {
    log.error({ code: persisted.error.code }, 'append unsupported-format reply failed')
  }

  try {
    if (humanize) {
      await sendWithPresence({ businessId, jid, text: reply, send })
    } else {
      await send(jid, reply)
    }
    log.info({ conversationId, format }, 'unsupported format notice sent')
  } catch (err) {
    log.error({ err, jid, format }, 'failed to send unsupported format notice')
  }
}

/**
 * Handles a photo from a customer.
 *
 * Three outcomes, in order of preference:
 *   1. forwarding on + the photo was expected → relay it to the owner
 *   2. forwarding off, no owner number, or the relay failed → the old text-only
 *      notice, so nothing regresses for businesses that never opted in
 *   3. forwarding on but the photo was NOT expected → the old notice too. An
 *      unsolicited picture is not something to push to a third phone.
 *
 * The acknowledgement to the customer never mentions that a human is involved:
 * from their side this is one continuous conversation with Emma.
 */
async function handleCustomerImage(params: {
  raw: WAMessage
  business: Business
  customer: Customer
  conversationId: string
  caption: string | null
  jid: string
  send: SendFn
  log: HandlerLogger
}): Promise<void> {
  const { raw, business, customer, conversationId, caption, jid, send, log } = params
  const businessId = business.id

  // Consumed unconditionally: one request buys one forward, whether or not the
  // rest of the path succeeds. Leaving it armed would relay the next photo too.
  const expectation = consumeImageExpectation(conversationId)
  const purpose = expectation?.purpose ?? null
  const payment = expectation?.payment ?? null

  const settingsResult = await businessService.getSettings(businessId)
  const forwardImages = settingsResult.ok ? shouldForwardImages(settingsResult.data) : false
  const requiresDeposit = settingsResult.ok ? settingsResult.data.requiresDeposit : false

  // The deposit gate in the tool executor reads this back: it is the only
  // persisted trace that a photo ever arrived. Recorded BEFORE the forward so a
  // failed relay cannot swallow the evidence and leave the customer stuck.
  try {
    await eventsRepo.create({
      businessId,
      conversationId,
      type: 'customer_image_received',
      payload: { purpose, hasCaption: caption !== null },
    })
  } catch (err) {
    log.error({ err }, 'failed to record customer_image_received event')
  }

  const pendingAppointment = await appointmentRepo.findPendingByCustomer(businessId, customer.id)

  // A customer waiting on the owner's approval is the one case worth relaying
  // without being asked: that photo is almost always the payment that unblocks
  // their appointment, and unlike the expectation above this signal survives a
  // deploy because it lives in the database.
  //
  // `requiresDeposit` joins them for a reason the other two cannot cover: under
  // the deposit gate there IS no pending appointment yet — the booking is
  // blocked precisely until this photo lands — so without this the capture that
  // unblocks it would be the one photo nobody forwards.
  const wanted = purpose !== null || pendingAppointment !== null || requiresDeposit

  let forwarded = false
  if (forwardImages && wanted && business.ownerWhatsappNumber) {
    forwarded = await relayImage({
      raw,
      business,
      customer,
      caption,
      pendingAppointment,
      purpose,
      payment,
      log,
    })
  } else {
    log.info(
      { conversationId, forwardImages, wanted, hasOwner: !!business.ownerWhatsappNumber },
      'customer image not forwarded',
    )
  }

  // The capture is the last thing the deposit gate was waiting for, so the
  // booking is filed HERE. Nothing else would: images never reach the model, so
  // leaving it to the next turn means no appointment exists until the customer
  // happens to send another text — and often they never do. The owner then gets
  // a payment capture for a booking that was never created.
  const booked = payment
    ? await bookFromPaymentCapture({ businessId, customerId: customer.id, payment, log })
    : null

  // await_payment has no other way out. Images never reach the model, so the
  // tool executor never sees the payment that this state exists to wait for,
  // and a conversation stuck there is not even offered check_availability.
  //
  // Only once the booking actually exists: a failed one has to keep waiting,
  // which is exactly what the marker below tells the model to retry.
  if (payment && booked) {
    const conversation = await conversationRepo.findById(businessId, conversationId)
    if (conversation) {
      const flowType = settingsResult.ok ? settingsResult.data.flowType : 'appointments'
      const applied = await conversationService.applyTrigger({
        businessId,
        conversationId,
        flowType,
        currentState: conversation.state,
        trigger: 'payment_received',
      })
      if (!applied.ok) {
        log.warn({ code: applied.error.code }, 'could not apply payment_received transition')
      }
    }
  }

  // Images never reach the model, so without this the next turn shows Emma
  // acknowledging a photo that appears nowhere in the history — and under the
  // deposit gate she has no way to know the capture arrived and the booking can
  // finally go through. A plain-text stand-in is what the model can read.
  //
  // When the booking already went through, the marker says so and forbids the
  // retry: otherwise the model reads "ya podés llamar book_appointment" on the
  // customer's next message and files the same appointment twice.
  const marker = payment
    ? booked
      ? `[El paciente envió la captura de pago para ${payment.service} y su cita ya quedó ${
          booked.status === 'pending' ? 'registrada como solicitud pendiente' : 'agendada'
        }. NO llames book_appointment de nuevo para ese horario.]`
      : `[El paciente envió una captura de pago para ${payment.service}${
          payment.amount ? ` (adelanto de ${payment.amount})` : ''
        }. Ya podés llamar book_appointment para ese horario.]`
    : '[El paciente envió una imagen.]'
  const markerPersisted = await messageService.append({
    businessId,
    conversationId,
    role: 'user',
    content: marker,
  })
  if (!markerPersisted.ok) {
    log.error({ code: markerPersisted.error.code }, 'append image marker failed')
  }

  // A failed booking falls back to the old wording on purpose: it promises
  // nothing, and the marker above still tells the model to retry next turn.
  const reply = booked
    ? booked.status === 'pending'
      ? PAYMENT_BOOKED_PENDING_REPLY
      : PAYMENT_BOOKED_CONFIRMED_REPLY
    : payment
      ? PAYMENT_IMAGE_REPLY
      : forwarded
        ? IMAGE_FORWARDED_REPLY
        : IMAGE_RECEIVED_REPLY
  const persisted = await messageService.append({
    businessId,
    conversationId,
    role: 'assistant',
    content: reply,
  })
  if (!persisted.ok) {
    log.error({ code: persisted.error.code }, 'append image acknowledgement failed')
  }

  try {
    await sendWithPresence({ businessId, jid, text: reply, send })
  } catch (err) {
    log.error({ err, jid }, 'failed to acknowledge customer image')
  }
}

/**
 * Files the appointment the deposit gate held back, now that its evidence
 * arrived. Never throws: the customer is waiting on an acknowledgement for the
 * photo they just sent, and a booking failure must not turn into silence.
 *
 * Calls the service directly, bypassing the tool executor's deposit gate on
 * purpose — the capture that gate demands landed and was persisted as
 * `customer_image_received` before this runs.
 *
 * The status is NOT forced: `bookAppointment` derives it from the business's
 * bookingMode, so a `requires_approval` business gets a pending row plus the
 * owner notification it already sends, and a `direct` one gets a confirmed
 * booking. The owner has seen the capture either way — the forward above
 * carried it with the service and time attached.
 *
 * Only ever reached with a live `PaymentContext`, and that expectation is
 * consumed on read, so a customer sending two captures back to back books once.
 */
async function bookFromPaymentCapture(params: {
  businessId: string
  customerId: string
  payment: PaymentContext
  log: HandlerLogger
}): Promise<Appointment | null> {
  const { businessId, customerId, payment, log } = params

  // Logged in full BEFORE the attempt: this path leaves no trace of its own
  // when it fails silently, and the frozen intent it books from — a service
  // name and a time the model chose minutes earlier — is exactly what has to
  // be inspected to explain a refusal.
  log.info(
    {
      customerId,
      service: payment.service,
      datetimeISO: payment.scheduledAtISO,
      customerName: payment.customerName,
      amount: payment.amount,
    },
    'booking appointment from payment capture',
  )

  try {
    const result = await appointmentService.bookAppointment({
      businessId,
      customerId,
      service: payment.service,
      datetimeISO: payment.scheduledAtISO,
      customerName: payment.customerName,
    })
    if (result.ok) {
      log.info(
        { appointmentId: result.data.id, status: result.data.status },
        'booked appointment from payment capture',
      )
      return result.data
    }
    log.error(
      {
        code: result.error.code,
        // The class name separates a ValidationError from a NotConfiguredError
        // at a glance; `code` alone does not.
        errorName: result.error.constructor.name,
        message: result.error.message,
        context: result.error.logContext,
        service: payment.service,
        datetimeISO: payment.scheduledAtISO,
        customerName: payment.customerName,
      },
      'failed to book appointment from payment capture',
    )
    return null
  } catch (err) {
    log.error(
      {
        err,
        service: payment.service,
        datetimeISO: payment.scheduledAtISO,
        customerName: payment.customerName,
      },
      'bookAppointment threw on payment capture path',
    )
    return null
  }
}

/**
 * Downloads the photo and hands it to the forwarder. Never throws: a failed
 * download or a failed send falls back to the text-only path, which is strictly
 * better than dropping the customer's message on the floor.
 */
async function relayImage(params: {
  raw: WAMessage
  business: Business
  customer: Customer
  caption: string | null
  pendingAppointment: Awaited<ReturnType<typeof appointmentRepo.findPendingByCustomer>>
  purpose: ImagePurpose | null
  payment: PaymentContext | null
  log: HandlerLogger
}): Promise<boolean> {
  const { raw, business, customer, caption, pendingAppointment, purpose, payment, log } = params

  const client = clientRegistry.getClient(business.id)
  if (!client) {
    log.warn({ businessId: business.id }, 'cannot forward image: no whatsapp client registered')
    return false
  }

  // No reupload context: the media was sent seconds ago and has not expired, so
  // the retry path Baileys offers there would never fire. A download that fails
  // anyway falls through to the text-only notice.
  let image: Buffer
  try {
    image = await downloadMediaMessage(raw, 'buffer', {})
  } catch (err) {
    log.error({ err, businessId: business.id }, 'failed to download customer image')
    return false
  }

  const sent = await mediaForwarder.forwardImageToOwner({
    client,
    business,
    customer,
    image,
    caption,
    pendingAppointment,
    purpose,
    payment,
  })
  if (!sent.ok) {
    log.error(
      { code: sent.error.code, context: sent.error.logContext },
      'failed to forward customer image to owner',
    )
    return false
  }
  return true
}

// Returns the peer's E.164 phone (with leading '+') from a Baileys JID or null
// for unsupported shapes. Handles classic '@s.whatsapp.net' JIDs and, since
// the LID migration, '@lid' JIDs where the real phone can live in any of:
// senderPn (older Baileys), remoteJidAlt (newer), or participant (fallback).
function jidToPhone(jid: string | undefined): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null
  const left = jid.slice(0, jid.indexOf('@'))
  if (!/^\d+$/.test(left)) return null
  return `+${left}`
}

function extractPhone(msg: WAMessage): string | null {
  const jid = msg.key.remoteJid
  if (!jid) return null

  const direct = jidToPhone(jid)
  if (direct) return direct

  if (jid.endsWith('@lid')) {
    const key = msg.key as {
      senderPn?: string
      remoteJidAlt?: string
      participant?: string
    }
    // Prefer a real phone if any related field exposes one.
    const real =
      jidToPhone(key.senderPn) ?? jidToPhone(key.remoteJidAlt) ?? jidToPhone(key.participant)
    if (real) return real

    // LID-only fallback: post-LID-migration, WA hides the real phone and only
    // exposes a stable LID (e.g. "153497903333610@lid"). We treat the digits
    // as a synthetic phone so downstream code (customer keying, DB uniqueness)
    // keeps working. It's not a real E.164 number, but it IS a stable per-user
    // identifier — same contact = same LID across all future messages.
    const left = jid.slice(0, jid.indexOf('@'))
    if (/^\d+$/.test(left)) return `+${left}`
  }

  return null
}

// What processMessage was handed: either readable text, or a format we can
// only acknowledge. Both still create the customer/conversation records.
type Payload =
  | { kind: 'text'; text: string }
  | { kind: 'image'; caption: string | null }
  | { kind: 'unsupported'; format: UnsupportedFormat }

// What the transcript records for a photo. The LLM reads this on the next turn,
// so it must not claim the image was discarded — told "no puedo procesar" after
// the photo already reached the owner, the model goes on to deny having
// received anything. It states only what is true either way: the image arrived
// and Emma cannot see it. Whether it went any further is carried by the
// assistant turn that follows, which is persisted too.
function imagePlaceholder(caption: string | null): string {
  const said = caption?.trim() ? ` con el texto: "${caption.trim()}"` : ''
  return `[El cliente envió una imagen${said}. No puedo verla]`
}

async function processMessage(
  raw: WAMessage,
  businessId: string,
  send: SendFn,
  jid: string,
  phone: string,
  payload: Payload,
): Promise<void> {
  const log = logger.child({ component: 'whatsapp.handler', businessId })

  // History placeholder for unreadable messages: without it the transcript
  // shows an assistant turn with nothing before it, which reads as a non
  // sequitur to the LLM on the next turn.
  const text =
    payload.kind === 'text'
      ? payload.text
      : payload.kind === 'image'
        ? imagePlaceholder(payload.caption)
        : `[El cliente envió ${describeFormat(payload.format)} que no puedo procesar]`

  // Load business once to figure out who is talking to us (owner or customer)
  // and to feed downstream services without re-fetching.
  const businessResult = await businessService.getById(businessId)
  if (!businessResult.ok) {
    log.error({ code: businessResult.error.code }, 'business not found for incoming message')
    return
  }
  const business = businessResult.data

  // DEMO COMMAND — #demo <profile> from the verified admin phone switches the
  // business profile instantly. Checked before owner/customer routing so it
  // works regardless of whether the admin is also the business owner.
  if (env.DEMO_ADMIN_PHONE && phone === env.DEMO_ADMIN_PHONE) {
    const trimmed = text.trim()
    const demoMatch = /^#demo\s+(\w+)$/i.exec(trimmed)
    if (demoMatch) {
      const keyword = demoMatch[1]!.toLowerCase()
      const result = await demoService.applyDemoProfile(businessId, keyword)
      let reply: string
      if (result.ok) {
        reply = `✅ Demo activado: *${result.data}*\nServicios, horarios y precios del perfil "${keyword}" ya están activos. El próximo mensaje al bot usará este perfil.`
      } else {
        reply = result.error.userMessage
      }
      log.info({ keyword, ok: result.ok }, 'demo command processed')
      try {
        await send(jid, reply)
      } catch {}
      return
    }
  }

  // OWNER FLOW — bypass customer lookup, talk to the personal assistant.
  //
  // Compared through samePhone, never with `===`: `phone` always carries a "+"
  // and the stored number usually does not, so a raw comparison sent the owner
  // down the customer path and Emma answered her own boss as a patient.
  if (samePhone(business.ownerWhatsappNumber, phone)) {
    const ownerThread = await conversationService.findOrCreateOwnerThread(businessId)
    if (!ownerThread.ok) {
      log.error({ code: ownerThread.error.code }, 'findOrCreateOwnerThread failed')
      return
    }

    // Includes images: forwarding points customer → owner, so a photo FROM the
    // owner has nowhere to go and stays a plain "text only" case, exactly as
    // before this feature existed.
    if (payload.kind !== 'text') {
      const format = payload.kind === 'image' ? 'image' : payload.format
      await recordUnsupportedEvent(businessId, ownerThread.data.id, format, phone, log)
      const persisted = await messageService.append({
        businessId,
        conversationId: ownerThread.data.id,
        role: 'user',
        content: text,
      })
      if (!persisted.ok) {
        log.error({ code: persisted.error.code }, 'append owner unsupported placeholder failed')
      }
      await respondUnsupportedFormat({
        businessId,
        conversationId: ownerThread.data.id,
        format,
        jid,
        send,
        log,
        // Owner flow: no anti-ban timing, this is an internal conversation.
        humanize: false,
      })
      return
    }

    const result = await ownerAssistantService.handle(businessId, ownerThread.data.id, text)
    let replyText: string
    if (result.ok) {
      replyText = sanitizeForWhatsApp(result.data.content)
      log.info(
        {
          conversationId: ownerThread.data.id,
          tokensInput: result.data.tokensInput,
          tokensOutput: result.data.tokensOutput,
          toolsExecuted: result.data.toolsExecuted,
          maxIterationsHit: result.data.maxIterationsHit,
        },
        'owner reply generated',
      )
    } else {
      replyText = OWNER_FALLBACK_REPLY
      log.error(
        { code: result.error.code, context: result.error.logContext },
        'owner assistant failed, using fallback',
      )
      // The owner service persists its own assistant turn on success; on
      // failure it doesn't, so we persist the fallback so the rolling memory
      // stays consistent.
      const fallbackPersist = await messageService.append({
        businessId,
        conversationId: ownerThread.data.id,
        role: 'assistant',
        content: replyText,
      })
      if (!fallbackPersist.ok) {
        log.error({ code: fallbackPersist.error.code }, 'append owner fallback message failed')
      }
    }

    try {
      await send(jid, replyText)
    } catch (err) {
      log.error({ err, jid }, 'failed to send owner reply over whatsapp')
    }
    return
  }

  // CUSTOMER FLOW — the historical path.
  const customerResult = await customerService.getOrCreate(
    businessId,
    phone,
    raw.pushName ?? undefined,
  )
  if (!customerResult.ok) {
    log.error(
      { err: customerResult.error.logContext, code: customerResult.error.code },
      'getOrCreate customer failed',
    )
    try {
      await sendWithPresence({ businessId, jid, text: LLM_FALLBACK_REPLY, send })
    } catch {}
    return
  }
  const customer = customerResult.data

  const conversationResult = await conversationService.getOrCreateOpen(businessId, customer.id)
  if (!conversationResult.ok) {
    log.error(
      {
        err: conversationResult.error.logContext,
        code: conversationResult.error.code,
      },
      'getOrCreateOpen conversation failed',
    )
    try {
      await sendWithPresence({ businessId, jid, text: LLM_FALLBACK_REPLY, send })
    } catch {}
    return
  }
  const conversation = conversationResult.data

  const userMsgResult = await messageService.append({
    businessId,
    conversationId: conversation.id,
    role: 'user',
    content: text,
  })
  if (!userMsgResult.ok) {
    log.error(
      { err: userMsgResult.error.logContext, code: userMsgResult.error.code },
      'append user message failed',
    )
    try {
      await sendWithPresence({ businessId, jid, text: LLM_FALLBACK_REPLY, send })
    } catch {}
    return
  }

  // Recorded before the paused check so the metric counts every occurrence,
  // not only the ones that got a reply. Images included: a photo that arrived
  // during a pause is still a photo this business received.
  if (payload.kind !== 'text') {
    const format = payload.kind === 'image' ? 'image' : payload.format
    await recordUnsupportedEvent(businessId, conversation.id, format, phone, log)
  }

  // BOT PAUSED — keep the customer record + the message, but skip LLM and
  // escalate so a human notices.
  const paused = await businessService.isBotPaused(businessId)
  if (paused) {
    const cannedPersist = await messageService.append({
      businessId,
      conversationId: conversation.id,
      role: 'assistant',
      content: PAUSED_REPLY,
    })
    if (!cannedPersist.ok) {
      log.error({ code: cannedPersist.error.code }, 'append paused canned reply failed')
    }

    const escalateResult = await conversationService.escalate(businessId, conversation.id)
    if (!escalateResult.ok) {
      log.error({ code: escalateResult.error.code }, 'escalating paused conversation failed')
    }

    try {
      await eventsRepo.create({
        businessId,
        conversationId: conversation.id,
        type: 'paused_blocked_message',
        payload: { phone, text_preview: text.slice(0, 50) },
      })
    } catch (err) {
      log.error({ err }, 'failed to record paused_blocked_message event')
    }

    log.warn(
      { conversationId: conversation.id, phone },
      'bot is paused; customer message escalated, canned reply sent',
    )

    // Fire-and-forget owner notification so the dueño knows someone wrote
    // during the pause window. Failures are warn-logged inside notifyOwner.
    // A nameless customer used to collapse this into "Cliente  - (+51...)",
    // which reads as if the name were the literal word "Cliente".
    const who = formatPersonName(customer.name) ?? '(sin nombre)'
    const phoneWho = phone
    const pausedText = [
      '⏸️ *Mensaje durante pausa*',
      `Cliente ${who} - (${phoneWho}) escribió mientras el bot está pausado.`,
      'Conversación marcada como escalada.',
    ].join('\n')
    ownerNotifier.notifyOwner(businessId, pausedText).catch((err) => {
      log.warn({ err }, 'notifyOwner during paused flow rejected unexpectedly')
    })

    try {
      await sendWithPresence({ businessId, jid, text: PAUSED_REPLY, send })
    } catch (err) {
      log.error({ err, jid }, 'failed to send paused canned reply')
    }
    return
  }

  // A photo Emma cannot read but the business can act on. Direct flow: no LLM
  // call, because there is nothing to reason about — the decision of whether it
  // matters was already made when Emma asked for it.
  if (payload.kind === 'image') {
    await handleCustomerImage({
      raw,
      business,
      customer,
      conversationId: conversation.id,
      caption: payload.caption,
      jid,
      send,
      log,
    })
    return
  }

  // Nothing to reason about — acknowledge the format and stop before the LLM.
  if (payload.kind === 'unsupported') {
    await respondUnsupportedFormat({
      businessId,
      conversationId: conversation.id,
      format: payload.format,
      jid,
      send,
      log,
      humanize: true,
    })
    return
  }

  // ESCALATED — a human owes this thread an answer. Replying with the LLM here
  // talks over them and makes the escalation we just promised look like it
  // never happened. Placed after the unsupported branch on purpose: a photo
  // sent mid-escalation must still reach the owner.
  if (conversation.status === 'escalated') {
    if (shouldSendEscalatedNotice(conversation.id)) {
      const persisted = await messageService.append({
        businessId,
        conversationId: conversation.id,
        role: 'assistant',
        content: ESCALATED_REPLY,
      })
      if (!persisted.ok) {
        log.error({ code: persisted.error.code }, 'append escalated canned reply failed')
      }
      try {
        await sendWithPresence({ businessId, jid, text: ESCALATED_REPLY, send })
        log.info({ conversationId: conversation.id }, 'escalated: canned reply sent, LLM skipped')
      } catch (err) {
        log.error({ err, jid }, 'failed to send escalated canned reply')
      }
    } else {
      log.info(
        { conversationId: conversation.id },
        'escalated: within notice cooldown, staying silent',
      )
    }
    return
  }

  // Normal LLM flow.
  const llmResult = await llmService.generateReply({
    businessId,
    conversationId: conversation.id,
    userMessage: text,
    state: conversation.state,
  })

  let replyText: string
  if (llmResult.ok) {
    replyText = sanitizeForWhatsApp(llmResult.data.content)
    log.info(
      {
        conversationId: conversation.id,
        tokensInput: llmResult.data.tokensInput,
        tokensOutput: llmResult.data.tokensOutput,
        toolsExecuted: llmResult.data.toolCallsExecuted.map((t) => t.name),
        escalated: llmResult.data.escalated,
        maxIterationsHit: llmResult.data.maxIterationsHit,
      },
      'llm reply generated',
    )
  } else {
    replyText = LLM_FALLBACK_REPLY
    log.error(
      { code: llmResult.error.code, context: llmResult.error.logContext },
      'llm generateReply failed, using fallback message',
    )
    const fallbackPersist = await messageService.append({
      businessId,
      conversationId: conversation.id,
      role: 'assistant',
      content: replyText,
    })
    if (!fallbackPersist.ok) {
      log.error(
        {
          err: fallbackPersist.error.logContext,
          code: fallbackPersist.error.code,
        },
        'append fallback assistant message failed',
      )
    }
  }

  log.info(
    { jid, replyLen: replyText.length, replyPreview: replyText.slice(0, 60) },
    'about to send reply over whatsapp',
  )
  try {
    await sendWithPresence({ businessId, jid, text: replyText, send })
    log.info({ jid }, 'reply sent successfully')
  } catch (err) {
    log.error({ err, jid }, 'failed to send reply over whatsapp')
  }
}

export function handleIncomingMessage(
  raw: WAMessage,
  businessId: string,
  send: SendFn,
): Promise<void> {
  const log = logger.child({ component: 'whatsapp.handler', businessId })

  if (raw.key.fromMe) {
    log.info({ jid: raw.key.remoteJid }, 'handler skip: fromMe')
    return Promise.resolve()
  }
  const jid = raw.key.remoteJid
  if (!jid) {
    log.info('handler skip: no remoteJid')
    return Promise.resolve()
  }
  if (jid.endsWith('@g.us') || jid === 'status@broadcast') {
    log.info({ jid }, 'handler skip: group or status')
    return Promise.resolve()
  }

  // Before the lock on purpose: the lock serialises duplicates, it does not
  // drop them, so a repeat that gets past here is answered a second time.
  // A message with no id cannot be identified — process it rather than guess.
  const messageId = raw.key.id
  if (messageId && !claimMessageId(`${businessId}:${messageId}`)) {
    log.info({ jid, messageId }, 'handler skip: duplicate messages.upsert for this message id')
    return Promise.resolve()
  }

  const phone = extractPhone(raw)
  if (!phone) {
    // Log everything we've got so we can see which field WA populated for
    // this LID message shape (senderPn / remoteJidAlt / participant).
    const key = raw.key as {
      senderPn?: string
      remoteJidAlt?: string
      participant?: string
    }
    log.warn(
      {
        jid,
        keyShape: Object.keys(raw.key),
        senderPn: key.senderPn,
        remoteJidAlt: key.remoteJidAlt,
        participant: key.participant,
      },
      'handler skip: no phone extractable from JID',
    )
    return Promise.resolve()
  }
  const incoming = classifyIncoming(raw)
  if (incoming.kind === 'ignorable') {
    // Unknown shapes are warn-logged rather than dropped quietly: silence here
    // is what hid the ephemeral-message bug, where ordinary text from anyone
    // using disappearing messages never reached Emma at all.
    if (incoming.reason === 'unknown') {
      log.warn({ jid, msgKeys: incoming.keys }, 'handler skip: unrecognised message shape')
    } else {
      log.info({ jid, reason: incoming.reason }, 'handler skip: no answerable payload')
    }
    return Promise.resolve()
  }

  log.info(
    incoming.kind === 'text'
      ? { phone, textPreview: incoming.text.slice(0, 60) }
      : incoming.kind === 'image'
        ? { phone, format: 'image', hasCaption: !!incoming.caption }
        : { phone, format: incoming.format },
    'handler accepted incoming message',
  )

  const senderKey = `${businessId}:${phone}`

  // Media and everything else bypasses the buffer: only text can be joined into
  // a sentence, and holding a photo back would delay the owner's notification
  // for no gain. A photo arriving mid-burst is therefore answered on its own,
  // possibly before the text it came with — accepted trade-off.
  if (incoming.kind !== 'text') {
    return withSenderLock(senderKey, () =>
      processMessage(raw, businessId, send, jid, phone, incoming),
    )
  }

  // Debounce sits AFTER dedup (so repeats never enter a burst) and BEFORE the
  // lock (holding the lock while waiting would serialise the very messages we
  // are trying to group).
  return bufferMessage(senderKey, incoming.text).then((joined) => {
    if (joined === null) {
      log.info({ phone }, 'handler: message folded into a later burst from the same sender')
      return
    }
    return withSenderLock(senderKey, () =>
      processMessage(raw, businessId, send, jid, phone, {
        kind: 'text',
        text: joined,
      }),
    )
  })
}
