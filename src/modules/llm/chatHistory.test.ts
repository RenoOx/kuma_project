import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js'
import { describe, expect, it } from 'vitest'
import type { Message } from '@/db/schema/index.js'
import { historyToChatMessages } from './chatHistory.js'

// Lo que se le manda a OpenAI tiene que ser una secuencia válida aunque la
// ventana de historial corte en el medio de una: si no, OpenAI rechaza el pedido
// entero y el cliente recibe "algo no salió bien" (Tecmin, 2026-09-30).

let seq = 0
function row(
  role: Message['role'],
  content: string,
  extra: { toolCallId?: string; calls?: string[] } = {},
): Message {
  seq++
  return {
    id: `m-${seq}`,
    conversationId: 'conv-1',
    businessId: 'biz-1',
    role,
    senderType: role === 'user' ? 'customer' : 'bot',
    content,
    toolCalls: extra.calls
      ? extra.calls.map((id) => ({
          id,
          type: 'function',
          function: { name: 'advance_flow', arguments: '{}' },
        }))
      : null,
    toolCallId: extra.toolCallId ?? null,
    createdAt: new Date(2026, 8, 30, 18, 0, seq),
  }
}

// La regla de OpenAI: cada respuesta de herramienta va justo después del pedido
// que la originó, y cada pedido tiene todas sus respuestas.
function isValidSequence(messages: ChatCompletionMessageParam[]): boolean {
  let awaiting = new Set<string>()
  for (const m of messages) {
    if (m.role === 'tool') {
      if (!awaiting.has(m.tool_call_id)) return false
      awaiting.delete(m.tool_call_id)
      continue
    }
    if (awaiting.size > 0) return false
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      awaiting = new Set(m.tool_calls.map((c) => c.id))
    }
  }
  return awaiting.size === 0
}

describe('historyToChatMessages', () => {
  it('drops a tool result whose request fell out of the window (the Tecmin case)', () => {
    // La ventana empieza con la respuesta de un advance_flow cuyo pedido quedó afuera.
    const history = [
      row('tool', '{"status":"advanced"}', { toolCallId: 'call-cut' }),
      row('assistant', 'Genial, ahora te paso un resumen de tus cursos'),
      row('user', 'el avanzado'),
      row('assistant', '', { calls: ['call-1'] }),
      row('tool', '{"status":"advanced"}', { toolCallId: 'call-1' }),
      row('assistant', 'Para brindarte tu descuento…'),
      row('user', 'el numero cual es?'),
    ]
    const out = historyToChatMessages(history)
    expect(isValidSequence(out)).toBe(true)
    expect(out[0]).toEqual({
      role: 'assistant',
      content: 'Genial, ahora te paso un resumen de tus cursos',
    })
    expect(out.at(-1)).toEqual({ role: 'user', content: 'el numero cual es?' })
  })

  it('drops both results when the window starts between two answers of one request', () => {
    const history = [
      row('tool', '{"status":"sent"}', { toolCallId: 'call-b' }),
      row('assistant', 'Te comento que este Lunes empezamos las clases.'),
      row('user', 'estaran en Lima?'),
    ]
    const out = historyToChatMessages(history)
    expect(isValidSequence(out)).toBe(true)
    expect(out.some((m) => m.role === 'tool')).toBe(false)
  })

  it('keeps a complete sequence with two tool calls as it is', () => {
    const history = [
      row('user', 'el avanzado'),
      row('assistant', '', { calls: ['call-a', 'call-b'] }),
      row('tool', '{"status":"sent"}', { toolCallId: 'call-a' }),
      row('tool', '{"status":"sent"}', { toolCallId: 'call-b' }),
      row('assistant', 'beneficios'),
    ]
    const out = historyToChatMessages(history)
    expect(isValidSequence(out)).toBe(true)
    expect(out.filter((m) => m.role === 'tool')).toHaveLength(2)
  })

  it('drops an unanswered request but keeps what it said to the customer', () => {
    const history = [
      row('user', 'hola'),
      row('assistant', 'Un momento', { calls: ['call-lost'] }),
      row('user', 'y?'),
    ]
    const out = historyToChatMessages(history)
    expect(isValidSequence(out)).toBe(true)
    expect(out[1]).toEqual({ role: 'assistant', content: 'Un momento' })
  })

  it('still hides emoji-only messages from the model', () => {
    const out = historyToChatMessages([row('user', '👍'), row('user', 'cuánto cuesta?')])
    expect(out).toEqual([{ role: 'user', content: 'cuánto cuesta?' }])
  })
})
