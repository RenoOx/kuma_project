import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions.js'
import type { Message } from '@/db/schema/index.js'
import { isIgnoredForModel } from '@/modules/whatsapp/messageKind.js'

/**
 * El historial de un cliente, tal como se le manda a OpenAI, con las secuencias
 * de herramientas reparadas.
 *
 * OpenAI rechaza el pedido ENTERO si una respuesta de herramienta no viene
 * justo después del pedido que la originó, o si un pedido queda sin respuesta.
 * La ventana de historial cuenta filas, no turnos, así que corta seguido en el
 * medio de una secuencia. Bug real (Instituto Tecmin, 2026-09-30): con el flujo
 * nuevo cada turno llama 2 o 3 herramientas, la ventana de 20 empezaba con una
 * respuesta huérfana y el cliente recibía "algo no salió bien" en vez del Yape.
 *
 * Misma reparación que ya hacía ownerAssistant.service (convertHistory): se
 * descartan los pedidos sin respuesta y las respuestas sin pedido, y lo que
 * caería en medio de una secuencia abierta se guarda hasta que cierre.
 */
export function historyToChatMessages(history: Message[]): ChatCompletionMessageParam[] {
  // Qué pedidos tienen respuesta en esta ventana: se decide antes de emitir el
  // pedido, porque un pedido a medias no puede salir.
  const answered = new Set<string>()
  for (const m of history) {
    if (m.role === 'tool' && m.toolCallId) answered.add(m.toolCallId)
  }

  const out: ChatCompletionMessageParam[] = []
  const deferred: ChatCompletionMessageParam[] = []
  let awaiting = new Set<string>()

  const flushDeferred = (): void => {
    out.push(...deferred)
    deferred.length = 0
  }
  const emit = (msg: ChatCompletionMessageParam): void => {
    if (awaiting.size > 0) deferred.push(msg)
    else out.push(msg)
  }

  for (const m of history) {
    if (m.role === 'system') continue

    if (m.role === 'tool') {
      // Sin pedido esperándola: su pedido quedó fuera de la ventana.
      if (!m.toolCallId || !awaiting.has(m.toolCallId)) continue
      out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content })
      awaiting.delete(m.toolCallId)
      if (awaiting.size === 0) flushDeferred()
      continue
    }

    if (m.role === 'assistant') {
      // toolCalls se guarda con la forma cruda de OpenAI (decisión del Día 7).
      const stored = m.toolCalls as ChatCompletionMessageToolCall[] | null | undefined
      const usable = stored?.filter((c) => answered.has(c.id)) ?? []
      if (usable.length > 0) {
        // Abre una secuencia: sale directo, porque tiene que ir ANTES de sus respuestas.
        out.push({
          role: 'assistant',
          content: m.content === '' ? null : m.content,
          tool_calls: usable,
        })
        awaiting = new Set(usable.map((c) => c.id))
        continue
      }
      // Sin pedidos utilizables, queda solo si además le dijo algo al cliente.
      if (m.content !== '') emit({ role: 'assistant', content: m.content })
      continue
    }

    if (m.role === 'user') {
      // Emojis sueltos y multimedia ignorada (sticker, video…) quedan guardados
      // para el Inbox, pero el modelo no los lee: si los viera, "no influyen" sería
      // mentira — un "😂" en el historial le cambiaba el tono de la respuesta.
      if (isIgnoredForModel(m.content)) continue
      emit({ role: 'user', content: m.content })
    }
  }

  // Una secuencia que queda abierta al final no retiene lo que guardó.
  flushDeferred()
  return out
}
