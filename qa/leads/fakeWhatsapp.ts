import type { WASocket } from '@whiskeysockets/baileys'
import type { WhatsappClient } from '@/modules/whatsapp/baileys.client.js'

// El WhatsApp falso del test. Se registra en clientRegistry en lugar del de
// Baileys y el handler lo usa igual que al real: le pasa cada texto, foto y
// documento. Acá no hay red — cada envío queda anotado con hora, destino y
// contenido.
//
// Las fotos llegan como Buffer. El arnés reemplaza las descargas (S3 y
// WhatsApp) por buffers que dicen de dónde vienen ("qa-media:<s3Key>",
// "qa-customer-photo:<id>"), así este registro puede decir QUÉ foto se mandó
// aunque los bytes sean de relleno.

export type OutboundKind = 'text' | 'image' | 'document' | 'audio' | 'video'

export interface OutboundRecord {
  at: number
  jid: string
  kind: OutboundKind
  text?: string
  caption?: string
  /** De dónde salió la foto: `s3:<key>` (panel) o `cliente:<id>` (foto reenviada). */
  media?: string
  error?: string
}

export interface FakeClientOptions {
  /** Latencia simulada de cada envío [min, max] ms. 0 en la prueba funcional. */
  latencyMs?: [number, number]
  /** Probabilidad de que un envío falle, para la prueba de carga. 0 por defecto. */
  failureRate?: number
  onSend: (record: OutboundRecord) => void
}

function mediaOrigin(buffer: Buffer): string | undefined {
  const head = buffer.subarray(0, 300).toString('utf8')
  if (head.startsWith('qa-media:')) return `s3:${head.slice('qa-media:'.length)}`
  if (head.startsWith('qa-customer-photo:'))
    return `cliente:${head.slice('qa-customer-photo:'.length)}`
  return undefined
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createFakeWhatsappClient(opts: FakeClientOptions): WhatsappClient {
  const [min, max] = opts.latencyMs ?? [0, 0]

  async function deliver(record: Omit<OutboundRecord, 'at'>): Promise<void> {
    if (max > 0) await sleep(min + Math.random() * (max - min))
    const failed = (opts.failureRate ?? 0) > 0 && Math.random() < (opts.failureRate ?? 0)
    opts.onSend({
      ...record,
      at: Date.now(),
      ...(failed ? { error: 'simulated send failure' } : {}),
    })
    if (failed) throw new Error('simulated send failure')
  }

  // Lo único del socket que toca el camino de un mensaje: marcar leído y
  // "escribiendo…". Los dos son cosméticos y acá no hacen nada.
  const sock = {
    readMessages: async () => {},
    sendPresenceUpdate: async () => {},
  } as unknown as WASocket

  return {
    sock,
    sendMessage: (jid, text) => deliver({ jid, kind: 'text', text }),
    sendImage: (jid, image, caption) => {
      const media = mediaOrigin(image)
      return deliver({
        jid,
        kind: 'image',
        ...(caption ? { caption } : {}),
        ...(media ? { media } : {}),
      })
    },
    sendDocument: (jid, document, _mimetype, fileName, caption) => {
      const media = mediaOrigin(document) ?? fileName
      return deliver({ jid, kind: 'document', media, ...(caption ? { caption } : {}) })
    },
    sendAudio: (jid, audio) => {
      const media = mediaOrigin(audio)
      return deliver({ jid, kind: 'audio', ...(media ? { media } : {}) })
    },
    sendVideo: (jid, video, caption) => {
      const media = mediaOrigin(video)
      return deliver({
        jid,
        kind: 'video',
        ...(caption ? { caption } : {}),
        ...(media ? { media } : {}),
      })
    },
    // Una etiqueta no es un envío: no cuenta como mensaje saliente.
    labelChat: () => Promise.resolve(),
    onMessage: () => {},
    onDisconnect: () => {},
    onQR: () => {},
    onConnect: () => {},
    onPairingCode: () => {},
    onCall: () => {},
    onContact: () => {},
    usernameFor: () => null,
    rejectCall: async () => {},
    requestPairingCode: async () => {
      throw new Error('fake whatsapp client: pairing is not available in tests')
    },
    close: async () => {},
    logout: async () => {},
  }
}
