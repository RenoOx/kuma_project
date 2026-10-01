import type { WAMessage } from '@whiskeysockets/baileys'

// Mensajes entrantes con la misma forma que entrega Baileys, para meterlos por
// handleIncomingMessage tal cual. Solo los campos que el handler lee: el jid,
// el id (deduplicación), el nombre de perfil y el contenido.
//
// El id de una foto lleva qué es ("captura", "dni"): la descarga simulada
// devuelve ese id como contenido, y así el registro del dueño muestra qué foto
// le llegó.

let sequence = 0

function key(jid: string, tag: string): WAMessage['key'] {
  sequence++
  return { remoteJid: jid, fromMe: false, id: `QA-${tag}-${Date.now()}-${sequence}` }
}

function base(
  jid: string,
  tag: string,
  pushName?: string,
): Pick<WAMessage, 'key' | 'messageTimestamp' | 'pushName'> {
  return {
    key: key(jid, tag),
    messageTimestamp: Math.floor(Date.now() / 1000),
    ...(pushName ? { pushName } : {}),
  }
}

export function textMessage(jid: string, text: string, pushName?: string): WAMessage {
  return { ...base(jid, 'txt', pushName), message: { conversation: text } } as WAMessage
}

export function imageMessage(
  jid: string,
  what: 'captura' | 'dni' | 'dni-reverso',
  caption?: string,
  pushName?: string,
): WAMessage {
  return {
    ...base(jid, what, pushName),
    message: { imageMessage: { mimetype: 'image/jpeg', ...(caption ? { caption } : {}) } },
  } as WAMessage
}

export function audioMessage(jid: string, pushName?: string): WAMessage {
  return {
    ...base(jid, 'audio', pushName),
    message: { audioMessage: { ptt: true, seconds: 14, mimetype: 'audio/ogg; codecs=opus' } },
  } as WAMessage
}

export function stickerMessage(jid: string, pushName?: string): WAMessage {
  return { ...base(jid, 'sticker', pushName), message: { stickerMessage: {} } } as WAMessage
}

export function pdfMessage(jid: string, caption?: string, pushName?: string): WAMessage {
  return {
    ...base(jid, 'pdf', pushName),
    message: {
      documentMessage: {
        mimetype: 'application/pdf',
        fileName: 'voucher.pdf',
        ...(caption ? { caption } : {}),
      },
    },
  } as WAMessage
}
