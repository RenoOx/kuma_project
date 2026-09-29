import { describe, expect, it } from 'vitest'
import type { Message } from '@/db/schema/index.js'
import { hoursSinceLastActivity } from './conversationRestart.js'

// Decide si un alumno que vuelve arranca de cero con la presentación: medir
// contra el mensaje equivocado lo reiniciaría a mitad de una charla, o nunca.

const NOW = new Date('2026-09-29T12:00:00Z')

function message(role: 'user' | 'assistant', hoursAgo: number): Message {
  return {
    id: `m-${role}-${hoursAgo}`,
    conversationId: 'conv-1',
    businessId: 'biz-1',
    role,
    senderType: role === 'user' ? 'customer' : 'bot',
    content: 'hola',
    toolCalls: null,
    toolCallId: null,
    createdAt: new Date(NOW.getTime() - hoursAgo * 60 * 60 * 1000),
  }
}

describe('hoursSinceLastActivity', () => {
  it('mide contra lo anterior al mensaje que abre el turno', () => {
    const history = [message('user', 30), message('assistant', 26), message('user', 0)]
    expect(hoursSinceLastActivity(history, NOW)).toBe(26)
  })

  it('saltea todos los mensajes seguidos del cliente al final, no solo el último', () => {
    const history = [message('assistant', 2), message('user', 0.1), message('user', 0)]
    expect(hoursSinceLastActivity(history, NOW)).toBe(2)
  })

  it('una conversación sin nada antes no tiene de qué reiniciarse', () => {
    expect(hoursSinceLastActivity([message('user', 0)], NOW)).toBeNull()
    expect(hoursSinceLastActivity([], NOW)).toBeNull()
  })
})
