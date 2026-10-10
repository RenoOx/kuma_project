import {
  downloadMediaMessage,
  NO_MESSAGE_FOUND_ERROR_TEXT,
  proto,
  type WAMessage,
  type WAMessageKey,
} from '@whiskeysockets/baileys'
import { env } from '@/config/env.js'
import { logger } from '@/config/logger.js'
import type { Appointment, Business, Customer } from '@/db/schema/index.js'
import * as appointmentRepo from '@/modules/appointment/appointment.repo.js'
import * as appointmentService from '@/modules/appointment/appointment.service.js'
import * as paymentVerificationService from '@/modules/appointment/paymentVerification.service.js'
import * as businessService from '@/modules/business/business.service.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import {
  activeServices,
  configuredMessage,
  shouldForwardImages,
} from '@/modules/business/business.settings.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import { fileConfigFor, resolveBusinessFlow } from '@/modules/conversation/flowSource.js'
import { blueprintFor } from '@/modules/conversation/nodeCatalog.js'
import { getStateConfig } from '@/modules/conversation/stateMachine.js'
import * as customerService from '@/modules/customer/customer.service.js'
import * as demoService from '@/modules/demo/demo.service.js'
import * as eventsRepo from '@/modules/events/events.repo.js'
import type { FixedOutbound } from '@/modules/llm/fixedMessage.js'
import * as llmService from '@/modules/llm/llm.service.js'
import type { ToolAttachment } from '@/modules/llm/toolExecutor.js'
import * as mediaService from '@/modules/media/media.service.js'
import * as messageService from '@/modules/message/message.service.js'
import { buildImagePlaceholder } from '@/modules/message/messageDisplay.js'
import * as ownerAssistantService from '@/modules/ownerAssistant/ownerAssistant.service.js'
import * as tagService from '@/modules/tag/tag.service.js'
import * as clientRegistry from '@/modules/whatsapp/clientRegistry.js'
import { bufferImage, flushImagesNow, hasPendingImages } from '@/modules/whatsapp/imageBuffer.js'
import {
  consumeImageExpectation,
  type ImagePurpose,
  type PaymentContext,
} from '@/modules/whatsapp/imageExpectation.js'
import { resolveLidPhone } from '@/modules/whatsapp/lidPhone.js'
import * as mediaForwarder from '@/modules/whatsapp/mediaForwarder.js'
import { bufferMessage } from '@/modules/whatsapp/messageBuffer.js'
import {
  classifyIncoming,
  describeFormat,
  IGNORED_CUSTOMER_FORMATS,
  IMAGE_FORWARDED_REPLY,
  IMAGE_RECEIVED_REPLY,
  isAudioFormat,
  isEmojiOnly,
  PAYMENT_BOOKED_CONFIRMED_REPLY,
  PAYMENT_BOOKED_PENDING_REPLY,
  PAYMENT_IMAGE_REPLY,
  PAYMENT_VERIFICATION_REPLY,
  pickAudioReply,
  quotedSummaryOf,
  replyForFormat,
  type UnsupportedFormat,
} from '@/modules/whatsapp/messageKind.js'
import {
  sendDirect,
  sendImageToCustomer,
  sendMediaToCustomer,
  sendWithPresence,
} from '@/modules/whatsapp/outbound.js'
import * as ownerNotifier from '@/modules/whatsapp/ownerNotifier.js'
import { recordOwnerNotification } from '@/modules/whatsapp/ownerThreadLog.js'
import {
  PLACEHOLDER_WAIT_MS,
  settle as settlePlaceholder,
  watch as watchPlaceholderMessage,
} from '@/modules/whatsapp/placeholderWatch.js'
import * as presence from '@/modules/whatsapp/presence.js'
import { markServiceImageSent } from '@/modules/whatsapp/sentServiceImages.js'
import { preview } from '@/shared/logRedact.js'
import { formatPersonName } from '@/shared/name.js'
import {
  customerContactLabel,
  customerFindHints,
  isLidPhone,
  normalizeWaUsername,
  samePhone,
  waUsernameOf,
} from '@/shared/phone.js'
import { renderTemplate } from '@/shared/templates.js'

// Cuando Emma no puede responder (OpenAI no contestó a tiempo, la base falló),
// el cliente ya no recibe "Mmm, algo no salió bien de mi lado. Intenta de nuevo
// en un momento": le pedía que reenviara, y en un pico eso multiplicaba los
// mensajes (Tecmin, 2026-09-30: 189 turnos así en una prueba). Su mensaje ya
// quedó guardado en el Inbox; el que se entera es el dueño, que puede
// contestarle desde ahí. Fire-and-forget, como el aviso de la pausa.
function notifyOwnerUnanswered(params: {
  businessId: string
  customerName: string | null
  phone: string
  reason: string
  log: HandlerLogger
  /** Si hay conversación, queda un evento `emma_unanswered` que cuenta el embudo del panel. */
  conversationId?: string
  /** Cómo encontrarlo en el WhatsApp Business sin número (`customerFindHints`). */
  findHints?: string[]
}): void {
  const who = formatPersonName(params.customerName) ?? '(sin nombre)'
  const text = [
    '⚠️ *Emma no pudo responder*',
    `Cliente: ${who} (${params.phone})`,
    ...(params.findHints ?? []),
    `Motivo: ${params.reason}`,
    'Su mensaje está en el Inbox: respóndele desde el panel.',
  ].join('\n')
  ownerNotifier.notifyOwner(params.businessId, text).catch((err) => {
    params.log.warn({ err }, 'notifyOwner for an unanswered message rejected unexpectedly')
  })
  // Sin esto, "Emma no pudo responder" solo existía en el WhatsApp del dueño: el
  // panel no tenía cómo contarlo.
  if (params.conversationId) {
    eventsRepo
      .create({
        businessId: params.businessId,
        conversationId: params.conversationId,
        type: 'emma_unanswered',
        payload: { reason: params.reason },
      })
      .catch((err: unknown) => {
        params.log.warn({ err }, 'failed to record emma_unanswered event')
      })
  }
}

const PAUSED_REPLY =
  'En este momento no podemos atenderte automáticamente. Un asesor te contactará pronto.'

// Sent when ownerAssistantService.handle itself fails — the owner never sees the
// model's voice in that case, so this string has to carry the same warmth the
// prompt asks for. It is NOT a "no puedo hacer eso": it means something broke.
const OWNER_FALLBACK_REPLY = 'Uy, no pude completar eso 😅 ¿Lo intentamos de nuevo?'

const ESCALATED_REPLY = 'Ya avisé al encargado, te escribirá en breve 😊'

// Lo que lee el modelo cuando una foto llega en un paso que no la pide, en un
// negocio con `earlyImages: 'continue'`. Va como mensaje del cliente, igual que
// las marcas de pago: el modelo nunca ve la foto, y sin esto no sabría que llegó.
const EARLY_IMAGE_MARKER =
  '[El cliente mandó una foto antes de que se la pidieras. No la ves y NO se le reenvió a nadie. Esto NO es una respuesta a tu última pregunta: no es un sí ni un no. No digas que la recibiste ni que la revisaste, y no pidas datos ni pagos con tus palabras: seguí el paso actual normalmente, y cuando corresponda pedir el pago o el DNI, pedile que la vuelva a mandar en ese momento.]'

// ── Configured canned replies ────────────────────────────────────────────────
//
// The three messages below leave WITHOUT passing through the model, which is why
// they read the owner's template verbatim instead of handing it over as guidance.
// Each falls back to the constant it replaces, so a business that never opened the
// Mensajes form keeps exactly the wording it has today.

function configuredHandoffText(settings: BusinessSettings | null, businessName: string): string {
  const configured = configuredMessage(settings, 'handoff')
  if (!configured) return ESCALATED_REPLY
  return renderTemplate(configured, { nombre_negocio: businessName })
}

// The frozen intent is the only place a service name and a customer name are both
// available on this path, so a template that uses either only fills in when one
// exists. renderTemplate drops the rest rather than showing braces.
function paymentVerificationText(
  settings: BusinessSettings | null,
  businessName: string,
  intent: { service: string; customerName: string } | null,
): string {
  const configured = configuredMessage(settings, 'paymentReceived')
  if (!configured) return PAYMENT_VERIFICATION_REPLY
  return renderTemplate(configured, {
    nombre_negocio: businessName,
    ...(intent ? { servicio: intent.service, nombre_cliente: intent.customerName } : {}),
  })
}

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

// Caps how many messages are being processed at once, across all senders and
// all tenants.
//
// The dispatch loop in baileys.client no longer awaits each handler, which is
// what stopped one slow conversation from holding up every other customer in the
// same batch. The cost of that is a fan-out: reconnecting after an outage
// delivers the whole offline backlog in one upsert, and without a cap fifty
// messages would open fifty concurrent GPT-4o-mini calls. OpenAI would rate-limit
// most of them and real patients would get the fallback line.
//
// Five is chosen to be well clear of that while still finishing a fifty-message
// backlog in ten rounds instead of a queue of fifty.
const MAX_CONCURRENT_PROCESSING = 5

let activeProcessing = 0
const processingWaiters: Array<() => void> = []

/**
 * Runs `work` once a processing slot is free.
 *
 * Applied AFTER the synchronous prologue and after the debounce, never around
 * them: dedup has to stay atomic against the event loop, and holding a slot
 * through a four-second debounce window would spend the budget on waiting rather
 * than on working.
 */
async function withProcessingSlot(work: (release: () => void) => Promise<void>): Promise<void> {
  if (activeProcessing >= MAX_CONCURRENT_PROCESSING) {
    // The slot is handed over already counted (see release below), so
    // nothing is incremented on this side of the wait.
    await new Promise<void>((resolve) => processingWaiters.push(resolve))
  } else {
    activeProcessing++
  }

  // `work` puede soltar el lugar antes de terminar: processMessage lo suelta
  // apenas Emma terminó de pensar, antes de enviar. El envío espera en la fila
  // de WhatsApp de ese número (segundos por mensaje), y retener el lugar ahí
  // hacía que un pico de un negocio frenara hasta ~1 min a los demás solo para
  // pensar. El orden por cliente lo sigue garantizando withSenderLock.
  let released = false
  const release = (): void => {
    if (released) return
    released = true
    // Hand the slot straight to the next waiter WITHOUT dropping the count.
    // Decrementing first and then resolving leaves a microtask-sized window in
    // which a fresh caller sees a free slot, takes it, and the woken waiter then
    // increments on top of it — the cap silently overshoots under exactly the
    // burst it exists to contain.
    const next = processingWaiters.shift()
    if (next) next()
    else activeProcessing--
  }

  try {
    await work(release)
  } finally {
    release()
  }
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
  readKey: WAMessageKey
  /**
   * El texto a mandar, si el que llama ya lo eligió (el cliente que mandó un
   * audio). Sin esto, el de siempre según el formato — lo que sigue usando el
   * chat del dueño.
   */
  text?: string
}): Promise<void> {
  const { businessId, conversationId, format, jid, send, log, humanize, readKey } = params

  if (!shouldSendUnsupportedNotice(conversationId)) {
    log.info({ conversationId, format }, 'unsupported format within cooldown; event only')
    return
  }

  const reply = params.text ?? (format === 'image' ? IMAGE_RECEIVED_REPLY : replyForFormat(format))
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
      await sendWithPresence({ businessId, jid, text: reply, send, readKey })
    } else {
      await sendDirect({ businessId, jid, text: reply, send, readKey })
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
  /** Si la foto vino en un grupo: la pausa y la respuesta se dejan para la última. */
  burst?: ImageBurst
}): Promise<'done' | 'reply_with_llm'> {
  const { raw, business, customer, conversationId, caption, jid, send, log, burst } = params
  const lastOfBurst = !burst || burst.index === burst.total - 1
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

  // The booking this capture pays for, resolved BEFORE the forward so the card
  // the owner reads names the service and the slot even when the intent came
  // from the row rather than from memory.
  //
  // The in-memory expectation is the fast path; the verification row behind it
  // is what survives a rejected capture, a restart, or an owner who answers an
  // hour later.
  //
  // The row is only consulted from await_payment — the one state that means "we
  // asked for a capture and nobody has accepted it yet". Reading it from
  // anywhere else would make an unrelated photo, sent weeks after the booking
  // was confirmed, look like payment for it all over again.
  const conversation = await conversationRepo.findById(businessId, conversationId)
  const flow = resolveBusinessFlow(businessId, settingsResult.ok ? settingsResult.data : null)
  const intent =
    payment ??
    (conversation?.state === 'await_payment'
      ? await paymentVerificationService.findLatestBooking(businessId, conversationId)
      : null)

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

  // Lo que el paso en que está la conversación pide hacer con una foto. Un paso
  // con reenvío configurado reenvía aunque el negocio no pida adelanto: es lo que
  // necesita un negocio de venta, que no tiene cita ni captura esperada.
  const onImage = conversation ? getStateConfig(flow, conversation.state).onImage : undefined

  // Regla del negocio (2026-09-28): una foto se atiende solo si el paso pide
  // requisitos o pagos (`onImage`) o si hay un pago esperado, una cita pendiente
  // o adelanto (`wanted`). Fuera de eso, silencio: antes Emma contestaba "¡Recibí
  // tu foto! Ya la comparto…" y no la compartía con nadie. El placeholder y el
  // evento de arriba se guardan igual, así el dueño la ve en el Inbox.
  if (!onImage && !wanted) {
    // Tampoco se reenvía con `earlyImages: 'continue'` (archivo del negocio): al
    // dueño le llega una foto recién cuando Emma la pidió, con la información
    // correcta ya dada. Lo que cambia es que Emma sigue el paso sabiendo que
    // llegó, en vez de dejar al cliente esperando en silencio (Tecmin,
    // 2026-09-30: el DNI llegaba junto con el "sí" y nadie respondía).
    // En un grupo, solo la última foto deja la marca y pide la respuesta.
    if (fileConfigFor(businessId)?.earlyImages === 'continue') {
      if (!lastOfBurst) return 'done'
      const marked = await messageService.append({
        businessId,
        conversationId,
        role: 'user',
        content: EARLY_IMAGE_MARKER,
        senderType: 'customer',
      })
      if (!marked.ok) {
        log.error({ code: marked.error.code }, 'append early image marker failed')
        return 'done'
      }
      log.info(
        { conversationId, state: conversation?.state },
        'customer image arrived before Emma asked: not forwarded, Emma continues the step',
      )
      return 'reply_with_llm'
    }
    log.info(
      { conversationId, state: conversation?.state },
      'customer image ignored: this step does not ask for photos',
    )
    return 'done'
  }

  // Downloaded at most once, and only when something will actually use the bytes:
  // the owner's relay, the S3 archive, or both. With forwarding off and no
  // deposit to archive there is nothing worth spending the bandwidth on.
  const needsRelay =
    (onImage?.forward === true || (forwardImages && wanted)) &&
    Boolean(business.ownerWhatsappNumber)
  const needsArchive = intent !== null && requiresDeposit
  const image = needsRelay || needsArchive ? await downloadImage(raw, log) : null

  // Archived before the verification row is opened, so the row can point at it.
  // Best-effort, exactly like the Google Calendar event in bookAppointment: a
  // bucket that is unconfigured or down must not cost the owner the request they
  // have to rule on. A failure here leaves proofKey null and changes nothing else.
  let proofKey: string | null = null
  if (needsArchive && image) {
    const stored = await mediaService.uploadMedia(
      { kind: 'payment_proof', businessId, conversationId },
      image,
    )
    if (stored.ok) {
      proofKey = stored.data.key
    } else {
      log.warn(
        { code: stored.error.code, context: stored.error.logContext },
        'could not archive the payment capture, opening the verification without it',
      )
    }
  }

  let forwarded = false
  if (needsRelay && image) {
    const stepCaption =
      onImage?.forward && conversation
        ? await buildStepImageNotice({
            business,
            settings: settingsResult.ok ? settingsResult.data : null,
            customer,
            conversationId,
            state: conversation.state,
            caption,
            paused: onImage.pause,
            ...(burst ? { photo: { index: burst.index, total: burst.total } } : {}),
            log,
          })
        : undefined
    forwarded = await relayImage({
      image,
      business,
      customer,
      caption,
      pendingAppointment,
      purpose,
      payment: intent,
      awaitsVerification: needsArchive,
      ...(stepCaption ? { stepCaption } : {}),
      log,
    })
  } else {
    log.info(
      { conversationId, forwardImages, wanted, hasOwner: !!business.ownerWhatsappNumber },
      'customer image not forwarded',
    )
  }

  // Pausa por paso: Emma se apaga en este chat con el mismo interruptor que usa
  // el Inbox, así el dueño la ve apagada y la vuelve a prender desde ahí. Si el
  // paso también pedía reenviar y el reenvío falló, NO se pausa: el dueño no se
  // enteró de nada y el cliente quedaría hablándole a nadie.
  //
  // En un grupo de fotos se decide foto por foto pero se aplica UNA vez, al
  // final: pausar con la primera hacía que las siguientes chocaran con "¿Emma
  // apagada?" y nunca le llegaran al dueño.
  const wantsPause = onImage?.pause === true && (!onImage.forward || forwarded)
  if (burst && wantsPause && !burst.shared.shouldPause) {
    burst.shared.shouldPause = true
    burst.shared.pauseState = conversation?.state ?? null
  }
  const pauseNow = burst ? lastOfBurst && burst.shared.shouldPause : wantsPause
  if (pauseNow) {
    const pausedIn = burst ? burst.shared.pauseState : (conversation?.state ?? null)
    try {
      await conversationRepo.setEmmaEnabled(businessId, conversationId, false)
      await eventsRepo.create({
        businessId,
        conversationId,
        type: 'emma_paused_on_image',
        payload: { state: pausedIn, photos: burst?.total ?? 1 },
      })
      log.info(
        { conversationId, state: pausedIn, photos: burst?.total ?? 1 },
        'emma paused after customer image',
      )

      // El lead queda "Por validar" para que el dueño lo califique desde el
      // panel (botones Pagó / No pagó en el chat). Solo si la pausa se aplicó, y
      // sin poder costarla: si falla —por ejemplo, el negocio ya tiene 10
      // etiquetas— solo se loguea.
      const marked = await tagService.markPendingValidation(businessId, conversationId)
      if (!marked.ok) {
        log.warn(
          { code: marked.error.code, conversationId },
          'could not tag the conversation as pending validation',
        )
      }
    } catch (err) {
      log.error({ err, conversationId }, 'failed to pause emma after customer image')
    }
  }

  // THE SPLIT. With a deposit, the capture buys a review, not a booking: Emma
  // cannot see the image, so filing the appointment here was taking the
  // customer's word for the money and handing the owner a fait accompli they
  // could only undo by cancelling on a patient Emma had already congratulated.
  //
  // Without a deposit there is nobody to review anything and the old path
  // stands: the capture is the last thing the gate was waiting for, and nothing
  // else would file the booking — images never reach the model, so leaving it
  // to the next turn means no appointment until the customer writes again, and
  // often they never do.
  const verification =
    intent && requiresDeposit
      ? await paymentVerificationService.openVerification({
          businessId,
          conversationId,
          customerId: customer.id,
          booking: intent,
          proofKey,
        })
      : null
  if (verification && !verification.ok) {
    log.error(
      { code: verification.error.code, context: verification.error.logContext },
      'could not open payment verification for this capture',
    )
  }
  const awaitingVerification = verification?.ok === true

  const booked =
    intent && !requiresDeposit
      ? await bookFromPaymentCapture({
          businessId,
          customerId: customer.id,
          payment: intent,
          log,
        })
      : null

  // await_payment has no other way out. Images never reach the model, so the
  // tool executor never sees the capture that this state exists to wait for,
  // and a conversation stuck there is not even offered check_availability.
  //
  // Only once something actually happened: a failed open or a failed booking
  // has to keep waiting, which is what the marker below tells the model.
  const trigger = awaitingVerification
    ? 'payment_capture_received'
    : booked
      ? 'payment_received'
      : null
  if (trigger && conversation) {
    const applied = await conversationService.applyTrigger({
      businessId,
      conversationId,
      flow,
      currentState: conversation.state,
      trigger,
    })
    if (!applied.ok) {
      log.warn({ code: applied.error.code, trigger }, 'could not apply capture transition')
    }
  }

  // Images never reach the model, so without this the next turn shows Emma
  // acknowledging a photo that appears nowhere in the history — and under the
  // deposit gate she has no way to know the capture arrived at all. A
  // plain-text stand-in is what the model can read.
  //
  // Every payment variant forbids book_appointment, for two different reasons:
  // once the booking exists, calling it again files the same appointment twice;
  // while the capture is under review, calling it books what nobody approved.
  //
  // Una foto común no lleva marcador propio: processMessage ya guardó
  // "[El cliente envió una imagen… No puedo verla]", y repetirlo dejaba dos filas
  // por foto (en el historial del modelo y en el Inbox). Los de pago sí van:
  // llevan instrucciones que el placeholder no tiene.
  const marker = intent
    ? awaitingVerification
      ? `[El cliente envió la captura de pago para ${intent.service}. La cita NO está creada: el pago está en verificación. NO llames book_appointment ni le confirmes la cita.]`
      : booked
        ? `[El cliente envió la captura de pago para ${intent.service} y su cita ya quedó ${
            booked.status === 'pending' ? 'registrada como solicitud pendiente' : 'agendada'
          }. NO llames book_appointment de nuevo para ese horario.]`
        : `[El cliente envió una captura de pago para ${intent.service}${
            intent.amount ? ` (adelanto de ${intent.amount})` : ''
          }, pero no pude registrarla. NO llames book_appointment ni le confirmes la cita: decile que la estás revisando.]`
    : // No frozen intent, and the business asks for a deposit: almost always a
      // customer who already knew where to pay — they saw the number on
      // Instagram, they came last month, the owner passed it to them — and paid
      // before Emma ever asked for a name or a slot. Nothing was registered, so
      // there is no verification for the owner to rule on and the generic marker
      // below would leave the model unaware a capture even arrived.
      //
      // 'reference' is excluded because a reference photo lands here too, with
      // the same null intent, and it is not a payment at all.
      requiresDeposit && purpose !== 'reference'
      ? '[El cliente envió una imagen que parece un comprobante de pago, pero no hay ninguna reserva registrada a la que asociarla. Pedile el horario y el nombre (los que falten) para poder registrarla. NO des el pago por recibido, NO le confirmes ninguna cita y NO llames book_appointment hasta tener esos datos.]'
      : null
  if (marker) {
    const markerPersisted = await messageService.append({
      businessId,
      conversationId,
      role: 'user',
      content: marker,
      senderType: 'customer',
    })
    if (!markerPersisted.ok) {
      log.error({ code: markerPersisted.error.code }, 'append image marker failed')
    }
  }

  // A failed open or a failed booking falls back to the old wording on purpose:
  // it promises nothing, which is the only honest thing to say when we do not
  // know whether this capture is going anywhere.
  // El mensaje que el dueño escribió para este paso gana sobre los de siempre.
  //
  // `rank` sigue el mismo orden de la cadena: en un grupo de fotos se manda UNA
  // sola respuesta, la más importante que haya salido — un grupo con la captura
  // y otra foto tiene que seguir diciendo "el encargado lo está verificando".
  const [reply, rank]: [string, number] = onImage?.reply
    ? [onImage.reply, 5]
    : awaitingVerification
      ? [
          paymentVerificationText(
            settingsResult.ok ? settingsResult.data : null,
            business.name,
            intent,
          ),
          4,
        ]
      : booked
        ? [
            booked.status === 'pending'
              ? PAYMENT_BOOKED_PENDING_REPLY
              : PAYMENT_BOOKED_CONFIRMED_REPLY,
            3,
          ]
        : intent
          ? [PAYMENT_IMAGE_REPLY, 2]
          : forwarded
            ? [IMAGE_FORWARDED_REPLY, 1]
            : [IMAGE_RECEIVED_REPLY, 0]

  let finalReply = reply
  if (burst) {
    const best = burst.shared.reply
    if (!best || rank > best.rank) burst.shared.reply = { text: reply, rank }
    // Las fotos que no son la última del grupo no le contestan nada al cliente:
    // tres fotos eran tres "¡Recibí tu imagen!", y cada uno un mensaje saliente.
    if (!lastOfBurst) return 'done'
    finalReply = burst.shared.reply?.text ?? reply
  }

  const persisted = await messageService.append({
    businessId,
    conversationId,
    role: 'assistant',
    content: finalReply,
  })
  if (!persisted.ok) {
    log.error({ code: persisted.error.code }, 'append image acknowledgement failed')
  }

  try {
    await sendWithPresence({ businessId, jid, text: finalReply, send, readKey: raw.key })
  } catch (err) {
    log.error({ err, jid }, 'failed to acknowledge customer image')
  }
  return 'done'
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
 * Pulls the bytes of an incoming photo, or null if that fails.
 *
 * No reupload context: the media was sent seconds ago and has not expired, so the
 * retry path Baileys offers there would never fire. A download that fails anyway
 * falls through to the text-only notice.
 *
 * Called once per photo by handleCustomerImage, because two things now want the
 * same bytes — the owner's relay and the S3 archive — and asking WhatsApp for
 * them twice would double the bandwidth for one message.
 */
/**
 * El aviso al dueño para una foto que llegó en un paso con reenvío configurado.
 *
 * El resumen es la descripción del servicio elegido, sin pasar por el modelo. Si
 * leer el historial falla, el aviso sale igual, sin resumen: la foto le tiene
 * que llegar al dueño aunque falte ese dato.
 */
async function buildStepImageNotice(params: {
  business: Business
  settings: BusinessSettings | null
  customer: Customer
  conversationId: string
  state: string
  caption: string | null
  paused: boolean
  /** Posición de la foto en el grupo que mandó el cliente junto, si vino en uno. */
  photo?: { index: number; total: number }
  log: HandlerLogger
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
  log: HandlerLogger
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

async function downloadImage(raw: WAMessage, log: HandlerLogger): Promise<Buffer | null> {
  try {
    return await downloadMediaMessage(raw, 'buffer', {})
  } catch (err) {
    log.error({ err }, 'failed to download customer image')
    return null
  }
}

/**
 * Hands an already-downloaded photo to the forwarder. Never throws: a failed
 * send falls back to the text-only path, which is strictly better than dropping
 * the customer's message on the floor.
 */
async function relayImage(params: {
  image: Buffer
  business: Business
  customer: Customer
  caption: string | null
  pendingAppointment: Awaited<ReturnType<typeof appointmentRepo.findPendingByCustomer>>
  purpose: ImagePurpose | null
  payment: PaymentContext | null
  awaitsVerification: boolean
  /** El aviso por paso ya armado; si viene, reemplaza al de siempre. */
  stepCaption?: string
  log: HandlerLogger
}): Promise<boolean> {
  const { image, business, customer, caption, pendingAppointment, purpose, payment, log } = params

  const client = clientRegistry.getClient(business.id)
  if (!client) {
    log.warn({ businessId: business.id }, 'cannot forward image: no whatsapp client registered')
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
    awaitsVerification: params.awaitsVerification,
    ...(params.stepCaption ? { stepCaption: params.stepCaption } : {}),
  })
  if (!sent.ok) {
    log.error(
      { code: sent.error.code, context: sent.error.logContext },
      'failed to forward customer image to owner',
    )
    return false
  }

  // The card the owner just read carries the patient's phone, service and slot.
  // Recorded in their thread so that answering it — "dile que no se ve bien" —
  // reaches the assistant with the phone already in context instead of making
  // it ask the owner for a number Emma herself sent seconds earlier.
  await recordOwnerNotification(business.id, sent.data.caption)

  return true
}

// Returns the peer's E.164 phone (with leading '+') from a Baileys JID or null
// for unsupported shapes. Handles classic '@s.whatsapp.net' JIDs and, since
// the LID migration, '@lid' JIDs where the real phone can live in any of:
// senderPn (older Baileys), remoteJidAlt (newer), or participant (fallback).
function jidToPhone(jid: string | undefined): string | null {
  if (!jid?.endsWith('@s.whatsapp.net')) return null
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
  | { kind: 'image'; caption: string | null; burst?: ImageBurst }
  | { kind: 'unsupported'; format: UnsupportedFormat }

/**
 * Una foto dentro de un grupo que el cliente mandó junto (ver imageBuffer.ts).
 *
 * `shared` es el MISMO objeto para todas las fotos del grupo: así la última sabe
 * si alguna anterior se reenvió, si el paso pidió pausar y cuál es la respuesta
 * más importante que salió. La pausa y la respuesta al cliente van una sola vez,
 * en la última foto — si la primera pausaba, las siguientes chocaban con "¿Emma
 * apagada?" y el dueño nunca las recibía.
 */
interface ImageBurst {
  index: number
  total: number
  shared: {
    shouldPause: boolean
    /** El estado en que estaba el chat cuando se pidió la pausa, para el evento. */
    pauseState: string | null
    reply: { text: string; rank: number } | null
  }
}

// What the transcript records for a photo. The LLM reads this on the next turn,
// so it must not claim the image was discarded — told "no puedo procesar" after
// the photo already reached the owner, the model goes on to deny having
// received anything. It states only what is true either way: the image arrived
// and Emma cannot see it. Whether it went any further is carried by the
// assistant turn that follows, which is persisted too.
// Moved to message/messageDisplay so the panel can render the same placeholder
// back as "📷 Imagen recibida" without matching on a string literal of its own.
const imagePlaceholder = buildImagePlaceholder

async function processMessage(
  raw: WAMessage,
  businessId: string,
  send: SendFn,
  jid: string,
  /** El de `extractPhone`: la clave del candado. Con un LID son sus dígitos. */
  lidPhone: string,
  payload: Payload,
  /** Suelta el lugar de procesamiento (ver withProcessingSlot). Sin él, se suelta al final. */
  releaseSlot?: () => void,
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

  // WhatsApp puede esconder el número detrás de un LID. Si Baileys sabe el real,
  // o es el del dueño, se usa para rutear y registrar: sin esto el dueño de
  // Tecmin entró como cliente "+243795362852927" (2026-10-05).
  const resolvedPhone = await resolveLidPhone(businessId, jid, business.ownerWhatsappNumber)
  const phone = resolvedPhone ?? lidPhone
  if (jid.endsWith('@lid') && !resolvedPhone) {
    // Qué manda WhatsApp cuando no da el número: decide si el @usuario del
    // cliente sirve para mostrarlo en su lugar.
    const key = raw.key as WAMessageKey
    log.info(
      {
        jid,
        remoteJidAlt: key.remoteJidAlt,
        remoteJidUsername: key.remoteJidUsername,
        participantUsername: key.participantUsername,
        addressingMode: key.addressingMode,
        hasPushName: Boolean(raw.pushName),
      },
      'lid without phone: number hidden by WhatsApp',
    )
  }

  // DEMO COMMAND — #demo <profile> from the verified admin phone switches the
  // business profile instantly. Checked before owner/customer routing so it
  // works regardless of whether the admin is also the business owner.
  if (env.DEMO_ADMIN_PHONE && phone === env.DEMO_ADMIN_PHONE) {
    const trimmed = text.trim()
    const demoMatch = /^#demo\s+(\w+)$/i.exec(trimmed)
    const demoKeyword = demoMatch?.[1]
    if (demoKeyword) {
      const keyword = demoKeyword.toLowerCase()
      const result = await demoService.applyDemoProfile(businessId, keyword)
      let reply: string
      if (result.ok) {
        reply = `✅ Demo activado: *${result.data}*\nServicios, horarios y precios del perfil "${keyword}" ya están activos. El próximo mensaje al bot usará este perfil.`
      } else {
        reply = result.error.userMessage
      }
      log.info({ keyword, ok: result.ok }, 'demo command processed')
      try {
        await sendDirect({ businessId, jid, text: reply, send, readKey: raw.key })
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
    // El respaldo de una entrega vacía es para clientes: al dueño no se le
    // contesta un mensaje que nadie pudo leer.
    if (payload.kind === 'text' && isUnreadableMarker(payload.text)) {
      log.info('owner placeholder never filled: ignored')
      return
    }
    // Un negocio cuyo archivo apaga el asistente del dueño: Emma solo le
    // notifica, nunca le contesta (Tecmin, 2026-10-01: el dueño reenvía los
    // avisos, y una respuesta de la IA en ese hilo solo confunde).
    if (fileConfigFor(businessId)?.ownerAssistant === false) {
      log.info({ kind: payload.kind }, 'owner message ignored: owner assistant disabled by file')
      return
    }
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
        // The owner typing on their own WhatsApp, not a customer.
        senderType: 'human',
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
        readKey: raw.key,
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
      await sendDirect({ businessId, jid, text: replyText, send, readKey: raw.key })
    } catch (err) {
      log.error({ err, jid }, 'failed to send owner reply over whatsapp')
    }
    return
  }

  // CUSTOMER FLOW — the historical path.
  // jid, not a rebuilt one: this is the address WhatsApp just delivered on, and
  // for a post-LID contact it is the only address that works.
  const customerResult = await customerService.getOrCreate(
    businessId,
    phone,
    raw.pushName ?? undefined,
    jid,
  )
  if (!customerResult.ok) {
    log.error(
      { err: customerResult.error.logContext, code: customerResult.error.code },
      'getOrCreate customer failed',
    )
    notifyOwnerUnanswered({
      businessId,
      customerName: raw.pushName ?? null,
      phone: customerContactLabel({ phone, waJid: jid }),
      findHints: customerFindHints(
        { phone, waJid: jid },
        { lastText: payload.kind === 'text' ? text : null },
      ),
      reason: 'no se pudo registrar al cliente en la base',
      log,
    })
    return
  }
  let customer = customerResult.data
  // Su @usuario de WhatsApp, tenga número o no: con número va al lado, sin número
  // es cómo el dueño lo encuentra en su WhatsApp Business. Se lee del mensaje que
  // ya llegó: nada de consultar a WhatsApp (riesgo de baneo, decisión del dueño
  // 2026-10-05). Viene en el atributo `username` del sobre, que Baileys no mapea
  // y el cliente de WhatsApp anota por LID (`usernameFor`); `remoteJidUsername`
  // queda por si Baileys empieza a mapearlo.
  const seenUsername =
    normalizeWaUsername((raw.key as WAMessageKey).remoteJidUsername) ??
    normalizeWaUsername(clientRegistry.getClient(businessId)?.usernameFor(jid))
  if (seenUsername) {
    const recorded = await customerService.recordWaUsername(businessId, customer, seenUsername)
    if (recorded.ok) {
      const blob =
        typeof customer.metadata === 'object' && customer.metadata !== null ? customer.metadata : {}
      customer = {
        ...customer,
        metadata: { ...blob, waUsernameSeen: seenUsername, waUsername: recorded.data },
      }
    } else {
      log.warn({ code: recorded.error.code }, 'record wa username failed')
    }
  }

  const conversationResult = await conversationService.getOrCreateOpen(businessId, customer.id)
  if (!conversationResult.ok) {
    log.error(
      {
        err: conversationResult.error.logContext,
        code: conversationResult.error.code,
      },
      'getOrCreateOpen conversation failed',
    )
    notifyOwnerUnanswered({
      businessId,
      customerName: customer.name,
      phone: customerContactLabel(customer),
      findHints: customerFindHints(customer, { lastText: payload.kind === 'text' ? text : null }),
      reason: 'no se pudo abrir la conversación en la base',
      log,
    })
    return
  }
  const conversation = conversationResult.data

  const userMsgResult = await messageService.append({
    businessId,
    conversationId: conversation.id,
    role: 'user',
    content: text,
    senderType: 'customer',
  })
  if (!userMsgResult.ok) {
    log.error(
      { err: userMsgResult.error.logContext, code: userMsgResult.error.code },
      'append user message failed',
    )
    notifyOwnerUnanswered({
      businessId,
      customerName: customer.name,
      phone: customerContactLabel(customer),
      findHints: customerFindHints(customer, { lastText: payload.kind === 'text' ? text : null }),
      reason: 'no se pudo guardar su mensaje en la base',
      log,
    })
    return
  }

  // Recorded before the paused check so the metric counts every occurrence,
  // not only the ones that got a reply. Images included: a photo that arrived
  // during a pause is still a photo this business received.
  if (payload.kind !== 'text') {
    const format = payload.kind === 'image' ? 'image' : payload.format
    await recordUnsupportedEvent(businessId, conversation.id, format, phone, log)
  }

  // Multimedia que Emma ignora (regla del negocio, 2026-09-28): solo emojis,
  // stickers, videos, documentos, ubicación y contactos. Ya quedaron guardados
  // arriba —el dueño los ve en el Inbox— y el modelo no los lee
  // (isIgnoredForModel en llm.service). Va ANTES de los gates: un sticker durante
  // la pausa del bot no tiene que disparar la escalada ni el aviso al dueño.
  const ignored =
    (payload.kind === 'text' && isEmojiOnly(payload.text)) ||
    (payload.kind === 'unsupported' && IGNORED_CUSTOMER_FORMATS.has(payload.format))
  if (ignored) {
    log.info(
      {
        conversationId: conversation.id,
        kind: payload.kind === 'unsupported' ? payload.format : 'emoji',
      },
      'customer message ignored: emoji-only or media Emma does not answer',
    )
    return
  }

  // EMMA SWITCHED OFF FOR THIS THREAD — the owner flipped the per-chat toggle
  // in the panel. Unlike the takeover below, nothing expires this: it holds
  // until the owner switches it back on.
  //
  // Checked first because it is the stronger statement of the two. A thread can
  // be both switched off and under an active takeover, and the answer is the
  // same either way, but the log line should say which decision is doing the
  // work.
  if (!conversation.emmaEnabled) {
    log.info(
      { conversationId: conversation.id, phone, kind: payload.kind },
      'emma switched off for this conversation; message stored, LLM skipped',
    )
    return
  }

  // HUMAN TAKEOVER — the owner is answering this thread from the panel, so Emma
  // stays out of it. The message is already persisted above, which is the whole
  // job here: the panel polls the transcript, so the owner sees what the
  // customer keeps writing while they hold the conversation.
  //
  // Placed here, not in handleIncomingMessage "before the debounce" as the
  // panel spec asked: neither the customer nor the conversation exists
  // that early, and resolving them there would mean two extra queries on every
  // inbound message plus a second place that knows how to find a thread. The
  // effect is identical — the debounce only joins consecutive texts into one
  // string, and no LLM call, no send and no anti-ban timing happens past this
  // point. `conversation` is already in hand, so this gate costs nothing.
  //
  // Read off humanTakeoverAt, which is the fact itself — the timestamp the
  // panel sets when the owner replies and the worker clears after 30 minutes.
  //
  // No reply of any kind: a canned "un momento" would be Emma talking over the
  // human who just took the thread.
  if (conversation.humanTakeoverAt !== null) {
    log.info(
      { conversationId: conversation.id, phone, kind: payload.kind },
      'human takeover active; message stored, LLM skipped',
    )
    return
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
    const phoneWho = customerContactLabel(customer)
    const pausedText = [
      '⏸️ *Mensaje durante pausa*',
      `Cliente ${who} - (${phoneWho}) escribió mientras el bot está pausado.`,
      ...customerFindHints(customer, { lastText: payload.kind === 'text' ? text : null }),
      'Conversación marcada como escalada.',
    ].join('\n')
    ownerNotifier.notifyOwner(businessId, pausedText).catch((err) => {
      log.warn({ err }, 'notifyOwner during paused flow rejected unexpectedly')
    })

    try {
      await sendWithPresence({ businessId, jid, text: PAUSED_REPLY, send, readKey: raw.key })
    } catch (err) {
      log.error({ err, jid }, 'failed to send paused canned reply')
    }
    return
  }

  // A photo Emma cannot read but the business can act on. Direct flow: no LLM
  // call, because there is nothing to reason about — the decision of whether it
  // matters was already made when Emma asked for it.
  if (payload.kind === 'image') {
    const outcome = await handleCustomerImage({
      raw,
      business,
      customer,
      conversationId: conversation.id,
      caption: payload.caption,
      jid,
      send,
      log,
      ...(payload.burst ? { burst: payload.burst } : {}),
    })
    // Una foto que llegó antes de tiempo en un negocio con `earlyImages`: no se
    // reenvió, y Emma contesta siguiendo el paso (más abajo, el flujo de LLM).
    if (outcome === 'done') return
  }

  // Nothing to reason about — acknowledge the format and stop before the LLM.
  // A esta altura solo llega audio o nota de voz: el resto de lo que no se puede
  // leer ya se ignoró arriba. El audio sí se contesta, pidiendo que escriba.
  if (payload.kind === 'unsupported') {
    await respondUnsupportedFormat({
      businessId,
      conversationId: conversation.id,
      format: payload.format,
      jid,
      send,
      log,
      humanize: true,
      readKey: raw.key,
      // El texto del negocio si su archivo lo declara; si no, las variantes de siempre.
      ...(isAudioFormat(payload.format)
        ? { text: fileConfigFor(businessId)?.audioReply ?? pickAudioReply() }
        : {}),
    })
    return
  }

  // ESCALATED — a human owes this thread an answer. Replying with the LLM here
  // talks over them and makes the escalation we just promised look like it
  // never happened. Placed after the unsupported branch on purpose: a photo
  // sent mid-escalation must still reach the owner.
  if (conversation.status === 'escalated') {
    if (shouldSendEscalatedNotice(conversation.id)) {
      // The owner's wording when they configured one, the built-in line otherwise.
      // Sent verbatim rather than through the model, because this whole branch
      // exists to keep the model from answering over a waiting human.
      const escalatedSettings = await businessService.getSettings(businessId)
      const handoffText = configuredHandoffText(
        escalatedSettings.ok ? escalatedSettings.data : null,
        business.name,
      )
      const persisted = await messageService.append({
        businessId,
        conversationId: conversation.id,
        role: 'assistant',
        content: handoffText,
      })
      if (!persisted.ok) {
        log.error({ code: persisted.error.code }, 'append escalated canned reply failed')
      }
      try {
        await sendWithPresence({ businessId, jid, text: handoffText, send, readKey: raw.key })
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

  // "listo" + la captura, mandados juntos: el texto espera 4 s y la foto 10 s,
  // así que el texto se procesaba primero y el cliente recibía "Aún no me llega
  // la captura" segundos antes de "Recibido ✅" (Tecmin, regresión 4). Si la foto
  // ya está esperando y este paso pausa a Emma al recibirla, la respuesta ES la
  // de la foto: el texto queda guardado (Inbox e historial) y no se llama a la IA.
  if (payload.kind === 'text' && hasPendingImages(`${businessId}:${lidPhone}`)) {
    const settingsResult = await businessService.getSettings(businessId)
    const flow = resolveBusinessFlow(businessId, settingsResult.ok ? settingsResult.data : null)
    if (getStateConfig(flow, conversation.state).onImage?.pause === true) {
      log.info(
        { conversationId: conversation.id, state: conversation.state },
        'text left to the incoming photo',
      )
      releaseSlot?.()
      return
    }
  }

  // Normal LLM flow.
  const llmResult = await llmService.generateReply({
    businessId,
    conversationId: conversation.id,
    userMessage: text,
    state: conversation.state,
  })
  // Lo que sigue es enviar: espera la fila de WhatsApp, no a OpenAI.
  releaseSlot?.()

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
    // Nada al cliente (ni se guarda un texto de Emma que no salió): el dueño
    // recibe el aviso y contesta desde el Inbox. Ver notifyOwnerUnanswered.
    replyText = ''
    log.error(
      { code: llmResult.error.code, context: llmResult.error.logContext },
      'llm generateReply failed, owner notified instead of sending a fallback',
    )
    notifyOwnerUnanswered({
      businessId,
      customerName: customer.name,
      phone: customerContactLabel(customer),
      findHints: customerFindHints(customer, { lastText: payload.kind === 'text' ? text : null }),
      reason:
        llmResult.error.code === 'llm_unavailable' || llmResult.error.code === 'llm_timeout'
          ? 'OpenAI no respondió a tiempo (mucho tráfico)'
          : 'error al generar la respuesta',
      log,
      conversationId: conversation.id,
    })
  }

  // Los mensajes fijos van ANTES de la respuesta: primero la oferta tal cual (y
  // su imagen), después la pregunta de Emma para seguir.
  if (llmResult.ok && llmResult.data.fixedMessages.length > 0) {
    await sendFixedMessages({
      businessId,
      jid,
      messages: llmResult.data.fixedMessages,
      send,
      readKey: raw.key,
      log,
    })
  }

  // Por defecto la foto va DESPUÉS del texto: ilustra lo que Emma acaba de
  // decir, y una que llega antes lee como un non sequitur. `mediaFirst`
  // (config del paso, ver stateMachine.ts) invierte esto para un paso que
  // LISTA varias opciones con foto y cierra con una invitación — ahí el
  // cliente tiene que ver todo el material antes de que le pregunten cuál
  // elige, no al revés.
  const mediaFirst = llmResult.ok && llmResult.data.mediaFirst

  if (mediaFirst && llmResult.ok && llmResult.data.attachments.length > 0) {
    await sendServiceImages({
      businessId,
      conversationId: conversation.id,
      jid,
      attachments: llmResult.data.attachments,
      log,
    })
  }

  // Vacío es válido: un turno que solo mandó mensajes fijos puede cerrar sin
  // texto propio (ver el comentario de mediaFirst/fixedOut en llm.service.ts).
  // Mandar un mensaje de WhatsApp en blanco no tiene sentido, así que se
  // salta directo — no es un error, no hay nada que loguear como fallo.
  if (replyText.trim() !== '') {
    log.info(
      { jid, replyLen: replyText.length, replyPreview: preview(replyText) },
      'about to send reply over whatsapp',
    )
    try {
      await sendWithPresence({ businessId, jid, text: replyText, send, readKey: raw.key })
      log.info({ jid }, 'reply sent successfully')
    } catch (err) {
      log.error({ err, jid }, 'failed to send reply over whatsapp')
    }
  }

  if (!mediaFirst && llmResult.ok && llmResult.data.attachments.length > 0) {
    await sendServiceImages({
      businessId,
      conversationId: conversation.id,
      jid,
      attachments: llmResult.data.attachments,
      log,
    })
  }
}

/**
 * Manda los mensajes fijos del turno, tal cual, cada uno seguido de su galería
 * de imágenes en orden (puede ser una sola, o ninguna).
 *
 * No tira nunca: la respuesta de Emma sale después igual. Una imagen que falta o
 * no se puede leer se registra y se saltea; el resto de la galería y el texto
 * ya salieron.
 */
async function sendFixedMessages(params: {
  businessId: string
  jid: string
  messages: FixedOutbound[]
  send: SendFn
  readKey: WAMessageKey | null | undefined
  log: HandlerLogger
}): Promise<void> {
  const { businessId, jid, messages, send, log } = params
  for (const message of messages) {
    // Un mensaje con bloques sale como varios mensajes de WhatsApp, en orden y
    // cada uno por la cola. Si un bloque falla, el resto del mensaje (y su
    // galería) no sale: la oferta a medias leería peor que ninguna.
    let failed = false
    for (const block of message.blocks ?? [message.text]) {
      try {
        await sendWithPresence({
          businessId,
          jid,
          text: block,
          send,
          ...(params.readKey ? { readKey: params.readKey } : {}),
        })
      } catch (err) {
        log.error({ err, jid }, 'failed to send fixed message')
        failed = true
        break
      }
    }
    if (failed) continue
    for (const key of message.images ?? []) {
      const downloaded = await mediaService.downloadMedia(businessId, key)
      if (!downloaded.ok) {
        log.warn(
          { code: downloaded.error.code, key },
          'could not read fixed message media from storage, reply went out without it',
        )
        continue
      }
      try {
        await sendImageToCustomer({ businessId, jid, image: downloaded.data })
      } catch (err) {
        log.error({ err, jid, key }, 'failed to send fixed message image')
      }
    }
  }
}

/**
 * Sends the service photos this turn asked for, one after the other.
 *
 * Never throws. The reply has already landed by the time this runs, and a photo
 * that cannot be read out of the bucket must not turn a good answer into an
 * error — the model was told to describe the service in words either way.
 */
async function sendServiceImages(params: {
  businessId: string
  conversationId: string
  jid: string
  attachments: ToolAttachment[]
  log: HandlerLogger
}): Promise<void> {
  const { businessId, conversationId, jid, attachments, log } = params

  for (const attachment of attachments) {
    const downloaded = await mediaService.downloadMedia(businessId, attachment.s3Key)
    if (!downloaded.ok) {
      log.warn(
        { code: downloaded.error.code, key: attachment.s3Key },
        'could not read service media from storage, reply went out without it',
      )
      continue
    }

    try {
      await sendMediaToCustomer({
        businessId,
        jid,
        type: attachment.type,
        buffer: downloaded.data,
        mimetype: attachment.mimetype,
        filename: attachment.filename,
        caption: attachment.caption,
      })
      // Recorded only once the send succeeded: marking it earlier would let a
      // single failure suppress that photo for the rest of the conversation.
      markServiceImageSent(conversationId, attachment.serviceId)
      log.info({ serviceId: attachment.serviceId, type: attachment.type }, 'service media sent')
    } catch (err) {
      log.error({ err, serviceId: attachment.serviceId }, 'failed to send service media')
    }
  }
}

/**
 * Lo que lee Emma en lugar del mensaje cuando una entrega vacía nunca recibió su
 * contenido (ver placeholderWatch.ts). Va como mensaje del cliente y queda en el
 * Inbox, así el dueño también ve qué pasó.
 */
export const UNREADABLE_MESSAGE_MARKER =
  '[El cliente te escribió, pero su mensaje no se pudo leer. Si es su primer mensaje, salúdalo y preséntate como siempre. Si ya venían conversando, pídele con amabilidad que te lo repita.]'

/**
 * La misma idea para el aviso de un anuncio de Meta ("Message absent from
 * node"): siempre es el primer contacto y el texto real es el prellenado del
 * anuncio, así que pedir que lo repita no tiene sentido.
 */
export const UNREADABLE_AD_MESSAGE_MARKER =
  '[El cliente llegó desde un anuncio de Meta y su mensaje no se pudo leer. Casi siempre es "¡Hola! Completé el formulario y me gustaría obtener más información". Salúdalo y preséntate como siempre.]'

function unreadableMarkerFor(reason: string | null): string {
  return reason === NO_MESSAGE_FOUND_ERROR_TEXT
    ? UNREADABLE_AD_MESSAGE_MARKER
    : UNREADABLE_MESSAGE_MARKER
}

function isUnreadableMarker(text: string): boolean {
  return text.includes(UNREADABLE_MESSAGE_MARKER) || text.includes(UNREADABLE_AD_MESSAGE_MARKER)
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

  const messageId = raw.key.id
  const watchKey = messageId ? `${businessId}:${messageId}` : null

  // Se clasifica ANTES de reservar el id. Un lead que llega desde un anuncio de
  // Meta entra primero como una entrega vacía y, un momento después, como el
  // mensaje real con el MISMO id (Baileys le pide el contenido al celular). Con
  // el id reservado por la vacía, el real se descartaba como duplicado: así se
  // perdieron 10 leads de Tecmin el 2026-10-10. Una entrega sin contenido no
  // reserva nada; la que trae algo sí.
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
    if (
      incoming.reason === 'empty' &&
      watchKey &&
      raw.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT
    ) {
      watchPlaceholder(raw, watchKey, businessId, send, jid, log)
    }
    return Promise.resolve()
  }

  if (watchKey && settlePlaceholder(watchKey)) {
    log.info({ jid, messageId, kind: incoming.kind }, 'placeholder filled')
  }

  // Before the lock on purpose: the lock serialises duplicates, it does not
  // drop them, so a repeat that gets past here is answered a second time.
  // A message with no id cannot be identified — process it rather than guess.
  if (watchKey && !claimMessageId(watchKey)) {
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

  // An inbound message is the one unambiguous sign somebody is working this
  // number. Placed after every filter so protocol noise and duplicates do not
  // keep a quiet number looking online all day.
  presence.markActive(businessId)

  log.info(
    incoming.kind === 'text'
      ? { phone, textLen: incoming.text.length, textPreview: preview(incoming.text) }
      : incoming.kind === 'image'
        ? { phone, format: 'image', hasCaption: !!incoming.caption }
        : { phone, format: incoming.format },
    'handler accepted incoming message',
  )

  const senderKey = `${businessId}:${phone}`

  // Las fotos se agrupan (imageBuffer.ts): el DNI de frente y de reverso, o el
  // DNI y la captura, llegan seguidos. Procesadas de a una, la primera pausaba a
  // Emma y las siguientes nunca le llegaban al dueño; en grupo, todas se
  // reenvían, la pausa va una vez al final y el cliente recibe una sola
  // respuesta. Se procesan en orden, bajo el mismo candado del remitente.
  if (incoming.kind === 'image') {
    return bufferImage(senderKey, { raw, caption: incoming.caption }).then((group) => {
      if (group === null) {
        log.info({ phone }, 'handler: photo folded into a later group from the same sender')
        return
      }
      const shared: ImageBurst['shared'] = { shouldPause: false, pauseState: null, reply: null }
      return withSenderLock(senderKey, () =>
        withProcessingSlot(async () => {
          for (const [index, photo] of group.entries()) {
            await processMessage(photo.raw, businessId, send, jid, phone, {
              kind: 'image',
              caption: photo.caption,
              burst: { index, total: group.length, shared },
            })
          }
        }),
      )
    })
  }

  // Everything else that is not text bypasses both buffers: there is nothing to
  // join and nothing to group.
  if (incoming.kind !== 'text') {
    return withSenderLock(senderKey, () =>
      withProcessingSlot((release) =>
        processMessage(raw, businessId, send, jid, phone, incoming, release),
      ),
    )
  }

  // Si el cliente usó "responder" de WhatsApp sobre una ficha, esa cita se
  // pierde apenas se junta con el resto en el buffer de abajo — para cuando
  // se procesa, el `raw` a mano es el ÚLTIMO mensaje de la ráfaga, no el que
  // citó nada. Por eso se adjunta ACÁ, antes de bufferMessage, para que viaje
  // dentro del texto que se junta y persiste.
  const quoted = quotedSummaryOf(raw)
  const text = quoted ? `[Sobre: "${quoted}"] ${incoming.text}` : incoming.text
  return dispatchText(raw, businessId, send, jid, phone, text, log)
}

/**
 * Un texto entra por acá, venga del cliente o del respaldo de una entrega vacía:
 * mismo agrupado, mismo candado, mismo lugar de procesamiento.
 */
function dispatchText(
  raw: WAMessage,
  businessId: string,
  send: SendFn,
  jid: string,
  phone: string,
  text: string,
  log: HandlerLogger,
): Promise<void> {
  const senderKey = `${businessId}:${phone}`

  // Un texto cierra el grupo de fotos pendiente del mismo cliente: "listo, ahí
  // están" no se tiene que contestar antes de procesar las fotos que mandó antes.
  flushImagesNow(senderKey)

  // Debounce sits AFTER dedup (so repeats never enter a burst) and BEFORE the
  // lock (holding the lock while waiting would serialise the very messages we
  // are trying to group).
  return bufferMessage(senderKey, text).then((joined) => {
    if (joined === null) {
      log.info({ phone }, 'handler: message folded into a later burst from the same sender')
      return
    }
    return withSenderLock(senderKey, () =>
      withProcessingSlot((release) =>
        processMessage(raw, businessId, send, jid, phone, { kind: 'text', text: joined }, release),
      ),
    )
  })
}

/**
 * Anota una entrega vacía y, si su contenido no llega a tiempo, hace que Emma
 * conteste igual con la marca que corresponda (`unreadableMarkerFor`): un lead de anuncio sin
 * respuesta es un lead perdido, y el dueño no tiene cómo enterarse.
 */
function watchPlaceholder(
  raw: WAMessage,
  watchKey: string,
  businessId: string,
  send: SendFn,
  jid: string,
  log: HandlerLogger,
): void {
  const reason = raw.messageStubParameters?.[0] ?? null
  const watched = watchPlaceholderMessage(watchKey, PLACEHOLDER_WAIT_MS, () => {
    // Reservar el id acá es lo que evita la doble respuesta: si el contenido
    // real aparece después, choca con esta reserva y se descarta.
    if (!claimMessageId(watchKey)) return
    const phone = extractPhone(raw)
    if (!phone) {
      log.warn({ jid, reason }, 'placeholder never filled and no phone to answer')
      return
    }
    log.warn({ jid, phone, reason }, 'placeholder never filled: answering without content')
    presence.markActive(businessId)
    dispatchText(raw, businessId, send, jid, phone, unreadableMarkerFor(reason), log).catch(
      (err: unknown) => {
        log.error({ err, jid }, 'placeholder fallback failed')
      },
    )
  })
  if (watched) log.info({ jid, messageId: raw.key.id, reason }, 'placeholder received')
}
