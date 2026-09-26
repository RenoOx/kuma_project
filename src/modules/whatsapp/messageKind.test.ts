import type { WAMessage } from '@whiskeysockets/baileys'
import { describe, expect, it } from 'vitest'
import { quotedSummaryOf } from './messageKind.js'

// Fixture mínima: solo lo que quotedSummaryOf lee. El resto del payload real
// de Baileys (key, messageTimestamp, etc.) no le importa a esta función.
function replyTo(quotedMessage: Record<string, unknown>, text = 'este'): WAMessage {
  return {
    message: {
      extendedTextMessage: {
        text,
        contextInfo: { quotedMessage },
      },
    },
  } as unknown as WAMessage
}

function plainText(text: string): WAMessage {
  return { message: { conversation: text } } as unknown as WAMessage
}

describe('quotedSummaryOf', () => {
  it('takes the first line of a quoted service card (nombre — precio)', () => {
    const quoted = {
      imageMessage: {
        caption:
          '*OPERACIÓN MÚLTIPLE Y MANTENIMIENTO DE EQUIPOS* — S/ 300\n· Aprendes a operar 07 equipos.\n· Vas a realizar 22 cursos técnicos del equipo.',
      },
    }
    expect(quotedSummaryOf(replyTo(quoted))).toBe(
      '*OPERACIÓN MÚLTIPLE Y MANTENIMIENTO DE EQUIPOS* — S/ 300',
    )
  })

  it('takes the caption of a quoted PDF or video the same way (same send path)', () => {
    expect(
      quotedSummaryOf(
        replyTo({ documentMessage: { caption: '*Ficha técnica* — S/ 250\n· Detalle.' } }),
      ),
    ).toBe('*Ficha técnica* — S/ 250')
    expect(
      quotedSummaryOf(
        replyTo({ videoMessage: { caption: '*Demo del equipo* — S/ 300\n· Detalle.' } }),
      ),
    ).toBe('*Demo del equipo* — S/ 300')
  })

  it('reads a quoted plain text message', () => {
    expect(quotedSummaryOf(replyTo({ conversation: '¿Cuál te gustaría iniciar?' }))).toBe(
      '¿Cuál te gustaría iniciar?',
    )
    expect(
      quotedSummaryOf(replyTo({ extendedTextMessage: { text: '¿Cuál te gustaría iniciar?' } })),
    ).toBe('¿Cuál te gustaría iniciar?')
  })

  it('returns null when the message is not a reply', () => {
    expect(quotedSummaryOf(plainText('hola'))).toBeNull()
  })

  it('returns null when what was quoted has nothing readable (a voice note, say)', () => {
    expect(quotedSummaryOf(replyTo({ audioMessage: { ptt: true } }))).toBeNull()
  })
})
