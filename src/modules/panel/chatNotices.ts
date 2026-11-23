// Lo que pasó en un chat sin ser un mensaje del chat: qué se le avisó al dueño y
// por qué Emma se pausó. El panel lo muestra intercalado, en su momento, como una
// burbuja gris. Sin base: recibe los eventos ya leídos.

/** Qué tipo de aviso es, para que el panel elija cómo dibujarlo. */
export type ChatNoticeKind = 'owner_notified' | 'emma_paused'

/** Los tipos de evento que se muestran en el chat. */
export const CHAT_NOTICE_EVENT_TYPES = [
  'owner_notified',
  'emma_paused_by_owner_reply',
  'emma_paused_on_image',
] as const

export interface NoticeEvent {
  id: string
  type: string
  payload: unknown
  createdAt: Date
}

export interface ChatNotice {
  id: string
  notice: ChatNoticeKind
  content: string
  createdAt: Date
}

function payloadText(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('text' in payload)) return null
  const text = (payload as { text: unknown }).text
  return typeof text === 'string' && text.trim() !== '' ? text : null
}

/** Un evento como aviso del chat, o null si no es de los que se muestran. */
export function noticeFromEvent(event: NoticeEvent): ChatNotice | null {
  const base = { id: `notice-${event.id}`, createdAt: event.createdAt }
  switch (event.type) {
    case 'owner_notified': {
      const text = payloadText(event.payload)
      return text ? { ...base, notice: 'owner_notified', content: text } : null
    }
    case 'emma_paused_by_owner_reply':
      return {
        ...base,
        notice: 'emma_paused',
        content: 'Emma se pausó en este chat: el dueño respondió desde su celular.',
      }
    case 'emma_paused_on_image':
      return {
        ...base,
        notice: 'emma_paused',
        content: 'Emma se pausó en este chat: llegó la foto que se pidió.',
      }
    default:
      return null
  }
}

/**
 * Intercala avisos y mensajes por fecha. A igual hora va primero el mensaje: el
 * aviso es siempre consecuencia de algo que pasó en el chat.
 */
export function interleaveNotices<T extends { createdAt: Date }>(
  messages: T[],
  notices: ChatNotice[],
): Array<T | ChatNotice> {
  const merged: Array<{ item: T | ChatNotice; at: number; rank: number; seq: number }> = [
    ...messages.map((item, seq) => ({ item, at: item.createdAt.getTime(), rank: 0, seq })),
    ...notices.map((item, seq) => ({ item, at: item.createdAt.getTime(), rank: 1, seq })),
  ]
  merged.sort((a, b) => a.at - b.at || a.rank - b.rank || a.seq - b.seq)
  return merged.map((m) => m.item)
}
