import { randomInt } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import * as conversationRepo from '@/modules/conversation/conversation.repo.js'
import * as conversationService from '@/modules/conversation/conversation.service.js'
import * as customerService from '@/modules/customer/customer.service.js'
import { isSafeImageName } from '@/modules/llm/fixedMessage.js'
import * as llmService from '@/modules/llm/llm.service.js'
import type { ExecutedToolCall } from '@/modules/llm/llm.types.js'
import * as mediaService from '@/modules/media/media.service.js'
import * as messageService from '@/modules/message/message.service.js'
import { NotFoundError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'

// Una conversación de prueba con Emma sin WhatsApp.
//
// Entra por el cerebro (llmService.generateReply, capas 4 y 5) y NO por el
// handler: el handler es el que envía, y además de texto manda fotos, PDF, avisos
// al dueño y el "escribiendo…" por el registro de sockets. Nada de eso existe
// acá, así que ningún mensaje puede salir a un número real.
//
// Lo que eso deja afuera, y la vista lo dice: el anti-ráfaga, la pausa, el
// control humano, el horario de atención y mandar fotos (capturas de pago).
//
// Lo que sí se escribe es real: el cliente de prueba, su conversación y sus
// mensajes, y lo que hagan las tools (una cita, datos capturados). Por eso la
// ruta solo existe con SIMULATOR_ENABLED=true, que en prod está apagado.

/** Prefijo +999: no es un código de país asignado, así que nunca choca con un cliente real. */
const SIMULATOR_PHONE_PREFIX = '+999'
const SIMULATOR_CUSTOMER_NAME = 'Prueba (simulador)'

export interface SimulatorAttachment {
  type: 'image' | 'pdf' | 'audio' | 'video'
  filename: string
  caption: string
  /** Link firmado por una hora, o null si el almacenamiento no está configurado. */
  url: string | null
}

/** Un mensaje fijo tal como lo recibiría el cliente, antes de la respuesta. */
export interface SimulatorFixedMessage {
  text: string
  /** La imagen como data URL para la vista previa; null si no hay o no se pudo leer. */
  image: string | null
  imageName: string | null
}

export interface SimulatorTurn {
  /** Salen primero, tal cual: la respuesta de Emma va después. */
  fixedMessages: SimulatorFixedMessage[]
  reply: string
  stateBefore: string
  stateAfter: string
  tools: ExecutedToolCall[]
  attachments: SimulatorAttachment[]
  escalated: boolean
  maxIterationsHit: boolean
  tokens: { input: number; output: number }
}

// La imagen de un mensaje fijo como data URL, para verla en la vista previa. Las
// imágenes de images/ son chicas (una foto de ejemplo), así que viajan en la
// respuesta y no hace falta servirlas aparte.
async function imageDataUrl(name: string): Promise<string | null> {
  if (!isSafeImageName(name)) return null
  try {
    const bytes = await readFile(path.join(process.cwd(), 'images', name))
    const ext = name.split('.').pop()?.toLowerCase()
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

/** Una sesión es un cliente de prueba distinto: empezar de nuevo es pedir otra. */
export function newSessionId(): string {
  return String(randomInt(0, 1_000_000_000)).padStart(9, '0')
}

export async function sendMessage(
  businessId: string,
  sessionId: string,
  text: string,
): Promise<Result<SimulatorTurn>> {
  const customer = await customerService.getOrCreate(
    businessId,
    `${SIMULATOR_PHONE_PREFIX}${sessionId}`,
    SIMULATOR_CUSTOMER_NAME,
  )
  if (!customer.ok) return customer

  const conversation = await conversationService.getOrCreateOpen(businessId, customer.data.id)
  if (!conversation.ok) return conversation
  const conversationId = conversation.data.id
  const stateBefore = conversation.data.state

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

  const reply = await llmService.generateReply({ businessId, conversationId, userMessage: text })
  if (!reply.ok) return reply

  const after = await conversationRepo.findById(businessId, conversationId)
  if (!after) {
    return err(new NotFoundError({ resource: 'conversation', logContext: { businessId } }))
  }

  const attachments: SimulatorAttachment[] = []
  for (const attachment of reply.data.attachments) {
    const url = await mediaService.getPresignedUrl(businessId, attachment.s3Key)
    attachments.push({
      type: attachment.type,
      filename: attachment.filename,
      caption: attachment.caption,
      url: url.ok ? url.data : null,
    })
  }

  const fixedMessages: SimulatorFixedMessage[] = []
  for (const fixed of reply.data.fixedMessages) {
    fixedMessages.push({
      text: fixed.text,
      image: fixed.image ? await imageDataUrl(fixed.image) : null,
      imageName: fixed.image ?? null,
    })
  }

  return ok({
    fixedMessages,
    reply: reply.data.content,
    stateBefore,
    stateAfter: after.state,
    tools: reply.data.toolCallsExecuted,
    attachments,
    escalated: reply.data.escalated,
    maxIterationsHit: reply.data.maxIterationsHit,
    tokens: { input: reply.data.tokensInput, output: reply.data.tokensOutput },
  })
}
