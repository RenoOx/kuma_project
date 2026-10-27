import { randomInt } from 'node:crypto'
import { logger } from '@/config/logger.js'
import * as appointmentRepo from '@/modules/appointment/appointment.repo.js'
import * as businessService from '@/modules/business/business.service.js'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import {
  fileConfigFor,
  findTestVersion,
  resolveBusinessFlow,
} from '@/modules/conversation/flowSource.js'
import { getStateConfig } from '@/modules/conversation/stateMachine.js'
import * as customerService from '@/modules/customer/customer.service.js'
import * as eventsRepo from '@/modules/events/events.repo.js'
import * as llmService from '@/modules/llm/llm.service.js'
import type { ExecutedToolCall, LLMResponse } from '@/modules/llm/llm.types.js'
import * as mediaService from '@/modules/media/media.service.js'
import * as messageService from '@/modules/message/message.service.js'
import { buildImagePlaceholder } from '@/modules/message/messageDisplay.js'
import {
  buildStepImageNotice,
  decideCustomerImage,
  EARLY_IMAGE_MARKER,
  pauseOnImage,
  shouldPauseAfterImage,
} from '@/modules/whatsapp/customerImage.js'
import { consumeImageExpectation } from '@/modules/whatsapp/imageExpectation.js'
import { IMAGE_FORWARDED_REPLY, IMAGE_RECEIVED_REPLY } from '@/modules/whatsapp/messageKind.js'
import { AppError, NotFoundError, ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import { runSimulation } from './simulationScope.js'

// Una conversación de prueba con Emma sin WhatsApp.
//
// Entra por el cerebro (llmService.generateReply, capas 4 y 5) y NO por el
// handler: el handler es el que envía, y además de texto manda fotos, PDF, avisos
// al dueño y el "escribiendo…" por el registro de sockets. Nada de eso existe
// acá, así que ningún mensaje puede salir a un número real.
//
// Las fotos de prueba sí siguen la regla de WhatsApp: deciden con las mismas
// funciones que el handler (whatsapp/customerImage.ts), pausan a Emma de verdad
// y marcan "Por validar". Lo que nunca hacen es reenviarse: el aviso que
// recibiría el dueño vuelve como texto para mostrarlo.
//
// Lo que esto deja afuera, y la vista lo dice: el anti-ráfaga, el control
// humano, el horario de atención y las capturas de pago de una cita con adelanto.
//
// Lo que sí se escribe es real: el cliente de prueba, su conversación y sus
// mensajes, y lo que hagan las tools (una cita, datos capturados). En prod solo
// existe para un negocio con una versión en prueba (pestaña "Pruebas"), y sus
// conversaciones no aparecen en el Inbox, Contactos, Dashboard ni el embudo.
//
// Cada turno corre en el contexto de prueba (simulationScope.ts): con la versión
// elegida, flowSource corre ese archivo y los notificadores no envían nada.

/**
 * Prefijo +999: no es un código de país asignado, así que nunca choca con un
 * cliente real. El panel lo usa para esconder estas conversaciones
 * (`SIMULATOR_PHONE_PATTERN` en panel.repo.ts): si cambia acá, cambia allá.
 */
const SIMULATOR_PHONE_PREFIX = '+999'
const SIMULATOR_CUSTOMER_NAME = 'Prueba (simulador)'

const log = logger.child({ component: 'simulator' })

export interface SimulatorAttachment {
  type: 'image' | 'pdf' | 'audio' | 'video'
  filename: string
  caption: string
  /** Link firmado por una hora, o null si el almacenamiento no está configurado. */
  url: string | null
}

/** Una imagen de una galería, subida por panel. */
export interface SimulatorFixedImage {
  /** Link firmado por una hora, o null si el almacenamiento no está configurado. */
  url: string | null
}

/** Un mensaje fijo tal como lo recibiría el cliente, antes de la respuesta. */
export interface SimulatorFixedMessage {
  text: string
  /** La galería completa, en orden — puede ser vacía. */
  images: SimulatorFixedImage[]
  /** La galería sale antes del texto (como en WhatsApp). */
  imagesFirst: boolean
}

/** Qué pasó con las fotos que mandó el cliente de prueba. */
export type SimulatorImageOutcome =
  /** Emma estaba apagada en este chat: se guardaron y nadie respondió. */
  | { kind: 'emma_paused' }
  /** El paso no pide fotos: se guardaron y Emma no respondió. */
  | { kind: 'ignored' }
  /** `earlyImages: 'continue'`: no se reenviaron y Emma siguió el paso. */
  | { kind: 'continued' }
  /** El paso pide fotos (`onImage`). */
  | {
      kind: 'handled'
      /** El aviso que le llegaría al dueño con la primera foto; null si no se reenvía. */
      forwardNotice: string | null
      paused: boolean
      tagged: boolean
    }
  /** Un caso que el simulador todavía no reproduce (captura de una cita con adelanto). */
  | { kind: 'not_simulated' }

export interface SimulatorTurn {
  /** Salen primero, tal cual: la respuesta de Emma va después. */
  fixedMessages: SimulatorFixedMessage[]
  reply: string
  stateBefore: string
  stateAfter: string
  tools: ExecutedToolCall[]
  attachments: SimulatorAttachment[]
  /** Los adjuntos salen antes del texto de Emma (`mediaFirst` del paso), como en WhatsApp. */
  mediaFirst: boolean
  escalated: boolean
  maxIterationsHit: boolean
  tokens: { input: number; output: number }
  /** Si Emma quedó apagada en este chat al terminar el turno. */
  emmaPaused: boolean
  /** Solo en un turno de fotos. */
  image?: SimulatorImageOutcome
}

/** Una sesión es un cliente de prueba distinto: empezar de nuevo es pedir otra. */
export function newSessionId(): string {
  return String(randomInt(0, 1_000_000_000)).padStart(9, '0')
}

async function openSession(businessId: string, sessionId: string) {
  const customer = await customerService.getOrCreate(
    businessId,
    `${SIMULATOR_PHONE_PREFIX}${sessionId}`,
    SIMULATOR_CUSTOMER_NAME,
  )
  if (!customer.ok) return customer
  const conversation = await conversationService.getOrCreateOpen(businessId, customer.data.id)
  if (!conversation.ok) return conversation
  return ok({ customer: customer.data, conversation: conversation.data })
}

/**
 * Corre un turno de prueba con la versión elegida (null = la de siempre). Una
 * versión que no es de este negocio, o que ya no existe, se rechaza: correr la de
 * siempre callado haría creer que se probó la nueva.
 */
function inVersion<T>(
  businessId: string,
  versionId: string | null,
  fn: () => Promise<Result<T>>,
): Promise<Result<T>> {
  if (versionId !== null && !findTestVersion(businessId, versionId)) {
    return Promise.resolve(
      err(
        new ValidationError({
          code: 'simulator_unknown_version',
          message: `test version ${versionId} not found`,
          userMessage: 'Esa versión en prueba ya no existe. Recarga la página.',
          logContext: { businessId, versionId },
        }),
      ),
    )
  }
  return runSimulation({ businessId, versionId }, fn)
}

/** Un turno sin respuesta de Emma (pausada, o una foto que el paso no pide). */
function silentTurn(state: string, emmaPaused: boolean, image?: SimulatorImageOutcome) {
  return {
    fixedMessages: [],
    reply: '',
    stateBefore: state,
    stateAfter: state,
    tools: [],
    attachments: [],
    mediaFirst: false,
    escalated: false,
    maxIterationsHit: false,
    tokens: { input: 0, output: 0 },
    emmaPaused,
    ...(image ? { image } : {}),
  } satisfies SimulatorTurn
}

/** La respuesta de Emma en la forma que la muestra la página, con los links firmados. */
async function turnFromReply(params: {
  businessId: string
  conversationId: string
  stateBefore: string
  reply: LLMResponse
  image?: SimulatorImageOutcome
}): Promise<Result<SimulatorTurn>> {
  const { businessId, conversationId, reply } = params
  const after = await conversationRepo.findById(businessId, conversationId)
  if (!after) {
    return err(new NotFoundError({ resource: 'conversation', logContext: { businessId } }))
  }

  const attachments: SimulatorAttachment[] = []
  for (const attachment of reply.attachments) {
    const url = await mediaService.getPresignedUrl(businessId, attachment.s3Key)
    attachments.push({
      type: attachment.type,
      filename: attachment.filename,
      caption: attachment.caption,
      url: url.ok ? url.data : null,
    })
  }

  const fixedMessages: SimulatorFixedMessage[] = []
  for (const fixed of reply.fixedMessages) {
    const images: SimulatorFixedImage[] = []
    for (const key of fixed.images ?? []) {
      const url = await mediaService.getPresignedUrl(businessId, key)
      images.push({ url: url.ok ? url.data : null })
    }
    fixedMessages.push({ text: fixed.text, images, imagesFirst: fixed.imagesFirst === true })
  }

  return ok({
    fixedMessages,
    reply: reply.content,
    stateBefore: params.stateBefore,
    stateAfter: after.state,
    tools: reply.toolCallsExecuted,
    attachments,
    mediaFirst: reply.mediaFirst,
    escalated: reply.escalated,
    maxIterationsHit: reply.maxIterationsHit,
    tokens: { input: reply.tokensInput, output: reply.tokensOutput },
    emmaPaused: !after.emmaEnabled,
    ...(params.image ? { image: params.image } : {}),
  })
}

export function sendMessage(
  businessId: string,
  sessionId: string,
  versionId: string | null,
  text: string,
): Promise<Result<SimulatorTurn>> {
  return inVersion(businessId, versionId, () => replyToText(businessId, sessionId, text))
}

async function replyToText(
  businessId: string,
  sessionId: string,
  text: string,
): Promise<Result<SimulatorTurn>> {
  const session = await openSession(businessId, sessionId)
  if (!session.ok) return session
  const { conversation } = session.data
  const conversationId = conversation.id
  const stateBefore = conversation.state

  // Igual que el handler: role 'user' y senderType 'customer'. Si se guardara
  // distinto, el historial que lee Emma no sería el de una conversación real.
  const appended = await messageService.append({
    businessId,
    conversationId,
    role: 'user',
    content: text,
    senderType: 'customer',
  })
  if (!appended.ok) return appended

  // El mismo corte que el handler: con Emma apagada en el chat (por ejemplo,
  // después de la foto del pago) el mensaje se guarda y nadie contesta.
  if (!conversation.emmaEnabled) return ok(silentTurn(stateBefore, true))

  const reply = await llmService.generateReply({ businessId, conversationId, userMessage: text })
  if (!reply.ok) return reply
  return turnFromReply({ businessId, conversationId, stateBefore, reply: reply.data })
}

/**
 * Fotos de prueba mandadas juntas: un grupo, como el DNI de frente y reverso.
 * Los bytes no viajan — la foto nunca llega al modelo ni se reenvía —, así que
 * alcanza con cuántas fueron y el texto que las acompañaba.
 */
export function sendImages(
  businessId: string,
  sessionId: string,
  versionId: string | null,
  count: number,
  caption: string | null,
): Promise<Result<SimulatorTurn>> {
  return inVersion(businessId, versionId, () =>
    receiveImages(businessId, sessionId, count, caption),
  )
}

async function receiveImages(
  businessId: string,
  sessionId: string,
  count: number,
  caption: string | null,
): Promise<Result<SimulatorTurn>> {
  const session = await openSession(businessId, sessionId)
  if (!session.ok) return session
  const { customer, conversation } = session.data
  const conversationId = conversation.id
  const state = conversation.state

  // Una fila por foto, como processMessage; el texto va con la primera.
  let lastPlaceholder = ''
  for (let i = 0; i < count; i++) {
    lastPlaceholder = buildImagePlaceholder(i === 0 ? caption : null)
    const appended = await messageService.append({
      businessId,
      conversationId,
      role: 'user',
      content: lastPlaceholder,
      senderType: 'customer',
    })
    if (!appended.ok) return appended
  }

  if (!conversation.emmaEnabled) return ok(silentTurn(state, true, { kind: 'emma_paused' }))

  const expectation = consumeImageExpectation(conversationId)
  for (let i = 0; i < count; i++) {
    try {
      await eventsRepo.create({
        businessId,
        conversationId,
        type: 'customer_image_received',
        payload: { purpose: i === 0 ? (expectation?.purpose ?? null) : null, hasCaption: false },
      })
    } catch (cause) {
      log.error({ err: cause }, 'failed to record customer_image_received event')
    }
  }

  const settings = await businessService.getSettings(businessId)
  const requiresDeposit = settings.ok ? settings.data.requiresDeposit : false
  const flow = resolveBusinessFlow(businessId, settings.ok ? settings.data : null)
  const onImage = getStateConfig(flow, state).onImage
  const pending = await appointmentRepo.findPendingByCustomer(businessId, customer.id)
  const wanted = expectation !== null || pending !== null || requiresDeposit

  const decision = decideCustomerImage({
    onImage,
    wanted,
    earlyImages: fileConfigFor(businessId)?.earlyImages,
  })

  if (decision === 'ignore') return ok(silentTurn(state, false, { kind: 'ignored' }))

  if (decision === 'continue_with_llm') {
    const marked = await messageService.append({
      businessId,
      conversationId,
      role: 'user',
      content: EARLY_IMAGE_MARKER,
      senderType: 'customer',
    })
    if (!marked.ok) return marked
    const reply = await llmService.generateReply({
      businessId,
      conversationId,
      userMessage: lastPlaceholder,
    })
    if (!reply.ok) return reply
    return turnFromReply({
      businessId,
      conversationId,
      stateBefore: state,
      reply: reply.data,
      image: { kind: 'continued' },
    })
  }

  // La captura de una cita con adelanto abre una verificación de pago y puede
  // agendar: eso no se reproduce acá. Se dice en vez de inventar el resultado.
  if (!onImage || requiresDeposit || expectation?.payment) {
    return ok(silentTurn(state, false, { kind: 'not_simulated' }))
  }

  const business = await businessService.getById(businessId)
  // Lo que haría el handler: reenviar si el paso lo pide y el negocio tiene
  // dueño. Acá "reenviar" es armar el aviso: nunca sale.
  const forwarded = onImage.forward && business.ok && Boolean(business.data.ownerWhatsappNumber)
  const forwardNotice =
    forwarded && business.ok
      ? await buildStepImageNotice({
          business: business.data,
          settings: settings.ok ? settings.data : null,
          customer,
          conversationId,
          state,
          caption,
          paused: onImage.pause,
          ...(count > 1 ? { photo: { index: 0, total: count } } : {}),
          log,
        })
      : null

  const pause = shouldPauseAfterImage(onImage, forwarded)
  const paused = pause
    ? await pauseOnImage({ businessId, conversationId, state, photos: count, log })
    : { paused: false, tagged: false }

  const replyText = onImage.reply ?? (forwarded ? IMAGE_FORWARDED_REPLY : IMAGE_RECEIVED_REPLY)
  const persisted = await messageService.append({
    businessId,
    conversationId,
    role: 'assistant',
    content: replyText,
  })
  if (!persisted.ok) return persisted

  return ok({
    ...silentTurn(state, paused.paused, {
      kind: 'handled',
      forwardNotice,
      paused: paused.paused,
      tagged: paused.tagged,
    }),
    reply: replyText,
  })
}

/** "Reactivar Emma": lo mismo que el interruptor del Inbox. */
export async function resume(businessId: string, sessionId: string): Promise<Result<void>> {
  const session = await openSession(businessId, sessionId)
  if (!session.ok) return session
  try {
    await conversationRepo.setEmmaEnabled(businessId, session.data.conversation.id, true)
    return ok(undefined)
  } catch (cause) {
    return err(
      new AppError({
        code: 'simulator_resume_failed',
        message: 'could not switch Emma back on in the simulator conversation',
        userMessage: 'No se pudo reactivar a Emma. Intenta de nuevo.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}
