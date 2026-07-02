import { logger as rootLogger } from '@/config/logger.js'
import {
  makeWASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import type { Boom } from '@hapi/boom'
import { mkdir } from 'node:fs/promises'
import pino from 'pino'
import qrcode from 'qrcode-terminal'

export type MessageHandler = (raw: WAMessage) => Promise<void> | void
export type DisconnectHandler = (reason: 'logout' | 'transient') => void
export type QRHandler = (qr: string) => void
export type ConnectHandler = () => void
export type PairingCodeHandler = (code: string) => void

export interface WhatsappClientOptions {
  businessId: string
  sessionDir: string
}

export interface WhatsappClient {
  sock: WASocket
  sendMessage(jid: string, text: string): Promise<void>
  onMessage(handler: MessageHandler): void
  onDisconnect(handler: DisconnectHandler): void
  onQR(handler: QRHandler): void
  onConnect(handler: ConnectHandler): void
  onPairingCode(handler: PairingCodeHandler): void
  requestPairingCode(phoneNumber: string): Promise<string>
}

export async function makeWhatsappClient(
  opts: WhatsappClientOptions,
): Promise<WhatsappClient> {
  const log = rootLogger.child({ component: 'baileys', businessId: opts.businessId })

  await mkdir(opts.sessionDir, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(opts.sessionDir)

  // Elevated to `info` while we stabilize prod pairing — surfaces protocol
  // events (stream errors, disconnect reasons) in Railway logs without full spam.
  const baileysLogger = pino({ level: 'info' })

  // WhatsApp's server rejects the handshake with a generic 500 if the client
  // doesn't announce a WA-Web version it accepts and a recognizable browser
  // identifier. fetchLatestBaileysVersion pulls the currently-supported one.
  const { version } = await fetchLatestBaileysVersion()
  log.info({ version }, 'using whatsapp web version')

  const sock = makeWASocket({
    auth: state,
    logger: baileysLogger,
    version,
    browser: Browsers.macOS('Desktop'),
    // Skip the full history sync on connect — we only need incoming messages
    // from now on, not the entire chat history.
    syncFullHistory: false,
    // Skip the initial sync/profile queries entirely. On fresh WA accounts
    // some of these queries hang forever and, when they finally hit the
    // internal timeout, Baileys tears down the whole stream. We don't need
    // the data those queries fetch (business profile, prefs, ...), we only
    // need incoming/outgoing messages.
    fireInitQueries: false,
    // Don't announce online presence to contacts. A bot doesn't need to leak
    // "last seen".
    markOnlineOnConnect: false,
    // Give any remaining IQ (not init) a long leash — 3 min instead of the
    // 60s default so a slow WA response doesn't kill the socket.
    defaultQueryTimeoutMs: 180_000,
    // Emit own outgoing messages back through the event stream. Not needed
    // for the bot; keeping it off reduces noise on the handler.
    emitOwnEvents: false,
  })

  const messageHandlers: MessageHandler[] = []
  const disconnectHandlers: DisconnectHandler[] = []
  const qrHandlers: QRHandler[] = []
  const connectHandlers: ConnectHandler[] = []
  const pairingCodeHandlers: PairingCodeHandler[] = []

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    log.info({ connection, hasQr: !!qr }, 'connection.update')

    if (qr) {
      log.info('whatsapp QR ready — scan it with the WhatsApp app on your phone')
      qrcode.generate(qr, { small: true })
      for (const handler of qrHandlers) handler(qr)
    }
    if (connection === 'open') {
      log.info('whatsapp connected')
      for (const handler of connectHandlers) handler()
    }
    if (connection === 'close') {
      const err = lastDisconnect?.error as Boom | undefined
      const statusCode = err?.output?.statusCode
      const errMessage = err?.message
      const isLoggedOut = statusCode === DisconnectReason.loggedOut
      log.warn(
        { statusCode, errMessage, isLoggedOut, disconnectReasonName: statusCode ? DisconnectReason[statusCode] : undefined },
        'whatsapp connection closed',
      )
      const reason: 'logout' | 'transient' = isLoggedOut ? 'logout' : 'transient'
      for (const handler of disconnectHandlers) handler(reason)
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    log.info({ type, count: messages.length }, 'messages.upsert received')
    if (type !== 'notify') return
    for (const m of messages) {
      log.info(
        {
          fromMe: m.key.fromMe,
          remoteJid: m.key.remoteJid,
          hasConversation: !!m.message?.conversation,
          hasExtendedText: !!m.message?.extendedTextMessage,
          msgKeys: m.message ? Object.keys(m.message) : [],
        },
        'dispatching message to handlers',
      )
      for (const handler of messageHandlers) {
        try {
          await handler(m)
        } catch (err) {
          log.error({ err }, 'message handler threw')
        }
      }
    }
  })

  return {
    sock,
    async sendMessage(jid, text) {
      log.info({ jid, textLen: text.length }, 'sock.sendMessage: calling')
      // LID recipients require the sender to have E2E key material fetched
      // and a signal session established. assertSessions alone often isn't
      // enough because WA delays returning key material until presence is
      // subscribed. Pattern that works: presenceSubscribe → delay →
      // assertSessions → send.
      if (jid.endsWith('@lid')) {
        try {
          await sock.presenceSubscribe(jid)
          log.info({ jid }, 'presenceSubscribe ok for lid')
        } catch (err) {
          log.warn({ err, jid }, 'presenceSubscribe failed')
        }
        await new Promise((r) => setTimeout(r, 800))
        try {
          await sock.assertSessions([jid], true)
          log.info({ jid }, 'assertSessions ok for lid')
        } catch (err) {
          log.warn({ err, jid }, 'assertSessions failed — send may still 463')
        }
      }
      const result = await sock.sendMessage(jid, { text })
      log.info({ jid, hasResult: !!result, messageId: result?.key?.id, status: result?.status }, 'sock.sendMessage: returned')
    },
    onMessage(handler) {
      messageHandlers.push(handler)
    },
    onDisconnect(handler) {
      disconnectHandlers.push(handler)
    },
    onQR(handler) {
      qrHandlers.push(handler)
    },
    onConnect(handler) {
      connectHandlers.push(handler)
    },
    onPairingCode(handler) {
      pairingCodeHandlers.push(handler)
    },
    async requestPairingCode(phoneNumber: string): Promise<string> {
      const digits = phoneNumber.replace(/\D/g, '')
      return sock.requestPairingCode(digits)
    },
  }
}
