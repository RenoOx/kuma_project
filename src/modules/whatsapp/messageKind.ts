import type { WAMessage } from '@whiskeysockets/baileys'

// Classification of an incoming WhatsApp message. Pure — no I/O, no logging —
// so the routing decision can be reasoned about and tested on its own.

// Images left this union when forwarding arrived: they are no longer a dead end
// Emma can only apologise for, so they carry their own kind. Everything here is
// still genuinely unreadable.
export type UnsupportedFormat =
  | 'video'
  | 'audio'
  | 'voice_note'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contact'

export type IncomingKind =
  | { kind: 'text'; text: string }
  // Photos are the one attachment the business can act on without Emma being
  // able to read it: a payment proof or a reference shot, relayed to the owner
  // untouched. The caption travels along because it is often the whole message
  // ("acá está el voucher").
  | { kind: 'image'; caption: string | null }
  | { kind: 'unsupported'; format: UnsupportedFormat }
  // Protocol noise and anything we don't recognise. `keys` is carried out so
  // the caller can log unknown shapes instead of dropping them invisibly —
  // that silence is how the ephemeral-message bug went unnoticed.
  | { kind: 'ignorable'; reason: 'empty' | 'protocol' | 'unknown'; keys: string[] }

// WhatsApp nests the real payload inside these when the sender has
// disappearing messages or view-once enabled. Unwrapping is what makes plain
// text from those chats reachable at all.
const WRAPPER_KEYS = [
  'ephemeralMessage',
  'viewOnceMessage',
  'viewOnceMessageV2',
  'viewOnceMessageV2Extension',
  'documentWithCaptionMessage',
] as const

// Bookkeeping WhatsApp sends on its own. Replying "please write text" to a
// thumbs-up reaction or a delete-for-everyone would be obnoxious.
const PROTOCOL_KEYS = new Set([
  'protocolMessage',
  'senderKeyDistributionMessage',
  'reactionMessage',
  'pollUpdateMessage',
  'messageContextInfo',
  'keepInChatMessage',
  'pinInChatMessage',
  'stickerSyncRmrMessage',
])

interface MessageNode {
  [key: string]: unknown
  message?: MessageNode | null
}

const MAX_UNWRAP_DEPTH = 4

function unwrap(node: MessageNode): MessageNode {
  let current = node
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth++) {
    const wrapperKey = WRAPPER_KEYS.find((key) => {
      const value = current[key]
      return typeof value === 'object' && value !== null
    })
    if (!wrapperKey) return current
    const inner = (current[wrapperKey] as MessageNode).message
    if (!inner || typeof inner !== 'object') return current
    current = inner
  }
  return current
}

function contentKeys(node: MessageNode): string[] {
  return Object.keys(node).filter((key) => node[key] !== null && node[key] !== undefined)
}

function asText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value
  return null
}

/**
 * Decides how an incoming message should be handled.
 *
 * Media carrying a caption is still reported as `unsupported`: Emma cannot see
 * the attachment, so answering only its caption means replying blind to a
 * question that may depend on what was sent.
 */
export function classifyIncoming(msg: WAMessage): IncomingKind {
  const root = msg.message as MessageNode | null | undefined
  if (!root) return { kind: 'ignorable', reason: 'empty', keys: [] }

  const node = unwrap(root)
  const keys = contentKeys(node)

  const plain = asText(node.conversation)
  if (plain) return { kind: 'text', text: plain }

  const extended = node.extendedTextMessage as { text?: unknown } | undefined
  const extendedText = extended ? asText(extended.text) : null
  if (extendedText) return { kind: 'text', text: extendedText }

  if (node.imageMessage) {
    const image = node.imageMessage as { caption?: unknown }
    return { kind: 'image', caption: asText(image.caption) }
  }
  if (node.videoMessage) return { kind: 'unsupported', format: 'video' }
  if (node.audioMessage) {
    const audio = node.audioMessage as { ptt?: unknown }
    return { kind: 'unsupported', format: audio.ptt === true ? 'voice_note' : 'audio' }
  }
  if (node.documentMessage) return { kind: 'unsupported', format: 'document' }
  if (node.stickerMessage) return { kind: 'unsupported', format: 'sticker' }
  if (node.locationMessage || node.liveLocationMessage) {
    return { kind: 'unsupported', format: 'location' }
  }
  if (node.contactMessage || node.contactsArrayMessage) {
    return { kind: 'unsupported', format: 'contact' }
  }

  if (keys.some((key) => PROTOCOL_KEYS.has(key))) {
    return { kind: 'ignorable', reason: 'protocol', keys }
  }
  return { kind: 'ignorable', reason: 'unknown', keys }
}

const FORMAT_LABELS: Record<UnsupportedFormat, string> = {
  video: 'un video',
  audio: 'un audio',
  voice_note: 'una nota de voz',
  document: 'un documento',
  sticker: 'un sticker',
  location: 'una ubicación',
  contact: 'un contacto',
}

/** Spanish noun phrase for the format, used in the placeholder history entry. */
export function describeFormat(format: UnsupportedFormat): string {
  return FORMAT_LABELS[format]
}

export const UNSUPPORTED_FORMAT_VARIANTS: ReadonlyArray<string> = [
  'Por ahora solo puedo leer mensajes de texto 😊 ¿Me escribes tu consulta y con gusto te ayudo?',
  '¡Hola! Por acá solo leo texto por el momento 😊 Cuéntame por escrito qué necesitas y te ayudo enseguida.',
  'Todavía no puedo abrir ese tipo de mensajes 😊 ¿Me lo escribes por texto? Así te ayudo mejor.',
]

// randomFn es inyectable para tests deterministas; en producción usa Math.random.
export function pickUnsupportedReply(randomFn: () => number = Math.random): string {
  const index = Math.floor(randomFn() * UNSUPPORTED_FORMAT_VARIANTS.length)
  const variant = UNSUPPORTED_FORMAT_VARIANTS[index] ?? UNSUPPORTED_FORMAT_VARIANTS[0]
  if (!variant) throw new Error('UNSUPPORTED_FORMAT_VARIANTS must not be empty')
  return variant
}

// Photos are the one unreadable format that is usually the point of the
// message, not an aside: a reference for a nail design or a hair colour. The
// generic "I only read text" answer reads as a dead end right where the
// customer expects a quote, so images get their own acknowledgement. Used when
// the business has forwarding OFF — unchanged from before forwarding existed.
export const IMAGE_RECEIVED_REPLY =
  '¡Recibí tu foto! Ya la comparto para que te confirmen el precio 😊'

// Used when the photo WAS relayed to the owner. Deliberately names nobody: the
// customer should experience one continuous conversation, so Emma never
// announces that a human is now looking. The handoff is only ever made explicit
// when the customer asks for a person, which escalate_to_human already covers.
export const IMAGE_FORWARDED_REPLY = '¡Recibí tu imagen! Dame un momentito y te confirmo 😊'

// Payment captures earn their own line: "te confirmo" alone leaves the customer
// unsure whether the thing being confirmed is the payment or the appointment.
// Names nobody, for the same reason as the two above.
export const PAYMENT_IMAGE_REPLY = '¡Recibí tu captura! Dame un momentito y te confirmo tu cita 😊'

// Sent when the capture actually unblocked the booking and the row was filed.
// Split in two because "quedó agendada" is a promise Emma must not make for a
// business whose bookingMode still puts a human between the request and the
// calendar — there the appointment is a request, and saying otherwise is the
// exact overpromise the deposit gate was added to stop.
export const PAYMENT_BOOKED_PENDING_REPLY =
  '¡Recibí tu captura! Tu solicitud de cita ya quedó registrada ✅ Te confirmo en un momentito 😊'

export const PAYMENT_BOOKED_CONFIRMED_REPLY =
  '¡Recibí tu captura! Tu cita ya quedó agendada ✅ Te espero 😊'

// Sent when the business charges a deposit: the capture is in, the booking is
// NOT, and it will not be until the owner has looked at the money.
//
// This is the one customer-facing line that names a human on purpose, and it
// breaks the "never mention the doctor or the encargado" rule that governs
// every other reply. The reason it earns the exception: the wait is real and
// unbounded here — it lasts until a person answers their WhatsApp — and
// "dame un momentito" for something that may take an hour is a promise Emma
// cannot keep. Naming the check is what makes the wait make sense.
// prompts.ts carries the matching carve-out so she does not contradict this
// two messages later.
export const PAYMENT_VERIFICATION_REPLY =
  '¡Recibí tu comprobante! El encargado lo está verificando y te confirmo apenas esté listo 😊'

export function replyForFormat(
  _format: UnsupportedFormat,
  randomFn: () => number = Math.random,
): string {
  return pickUnsupportedReply(randomFn)
}

export const CALL_REJECTED_VARIANTS: ReadonlyArray<string> = [
  'Hola 😊 No puedo atender llamadas, pero por acá te ayudo al toque. ¿Me escribes tu consulta?',
  '¡Hola! Por este número la atención es solo por chat escrito 😊 Cuéntame en qué te puedo ayudar.',
]

export function pickCallRejectedReply(randomFn: () => number = Math.random): string {
  const index = Math.floor(randomFn() * CALL_REJECTED_VARIANTS.length)
  const variant = CALL_REJECTED_VARIANTS[index] ?? CALL_REJECTED_VARIANTS[0]
  if (!variant) throw new Error('CALL_REJECTED_VARIANTS must not be empty')
  return variant
}
