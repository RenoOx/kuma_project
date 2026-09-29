import type { WAMessage } from '@whiskeysockets/baileys'
import { describe, expect, it } from 'vitest'
import {
  AUDIO_REPLY_VARIANTS,
  isEmojiOnly,
  isIgnoredForModel,
  pickAudioReply,
  quotedSummaryOf,
} from './messageKind.js'

describe('isEmojiOnly', () => {
  it('reconoce mensajes hechos solo de emojis', () => {
    for (const text of ['👍', '😂😂', '❤️', '👍🏽', '🇵🇪', ' 🙏 😊 ', '👨‍👩‍👧']) {
      expect(isEmojiOnly(text), text).toBe(true)
    }
  })

  it('no toca nada que traiga letras o números: esas son respuestas', () => {
    // "1" y "A" contestan las opciones con letra; "sí 👍" es un sí.
    for (const text of ['1', 'A', 'sí 👍', 'ok', '', '   ']) {
      expect(isEmojiOnly(text), JSON.stringify(text)).toBe(false)
    }
  })
})

describe('isIgnoredForModel', () => {
  it('saca los emojis sueltos y los placeholders de formatos ignorados', () => {
    expect(isIgnoredForModel('😂')).toBe(true)
    expect(isIgnoredForModel('[El cliente envió un sticker que no puedo procesar]')).toBe(true)
    expect(isIgnoredForModel('[El cliente envió un video que no puedo procesar]')).toBe(true)
  })

  it('deja lo que el modelo sí tiene que ver: texto, audio y fotos', () => {
    expect(isIgnoredForModel('quiero el básico')).toBe(false)
    // El audio recibió respuesta ("escribime"): sin esta fila, esa respuesta
    // quedaría sin nada antes en el historial.
    expect(isIgnoredForModel('[El cliente envió una nota de voz que no puedo procesar]')).toBe(
      false,
    )
    expect(isIgnoredForModel('[El cliente envió una imagen. No puedo verla]')).toBe(false)
  })
})

describe('pickAudioReply', () => {
  it('devuelve una de las variantes de audio', () => {
    expect(AUDIO_REPLY_VARIANTS).toContain(pickAudioReply(() => 0))
    expect(AUDIO_REPLY_VARIANTS).toContain(pickAudioReply(() => 0.99))
  })
})

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
