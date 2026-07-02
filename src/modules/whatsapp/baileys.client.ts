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
  // If set and creds are not yet registered, requestPairingCode fires immediately
  // after socket creation (before the QR handshake advances on WA servers).
  pairingPhoneNumber?: string
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

  // Ubuntu/Chrome is the most reliable browser identifier for pairing codes in
  // recent Baileys releases — macOS + Safari has been rejected sporadically by
  // WA multi-device when passkey is enrolled.
  const sock = makeWASocket({
    auth: state,
    logger: baileysLogger,
    version,
    browser: Browsers.ubuntu('Chrome'),
  })

  const messageHandlers: MessageHandler[] = []
  const disconnectHandlers: DisconnectHandler[] = []
  const qrHandlers: QRHandler[] = []
  const connectHandlers: ConnectHandler[] = []
  const pairingCodeHandlers: PairingCodeHandler[] = []

  // Track whether we already requested a pairing code for this session.
  let pairingCodeRequested = false

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    log.info({ connection, hasQr: !!qr, pairingCodeRequested }, 'connection.update')

    // Request pairing code the first time WA is ready to authenticate (same
    // moment the QR would be emitted). This avoids calling too early when the
    // WebSocket isn't established yet.
    if (qr && opts.pairingPhoneNumber && !state.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true
      const digits = opts.pairingPhoneNumber.replace(/\D/g, '')
      log.info({ phone: `***${digits.slice(-4)}` }, 'requesting pairing code')
      sock.requestPairingCode(digits).then((code) => {
        log.info({ codeLen: code.length }, 'pairing code generated')
        for (const h of pairingCodeHandlers) h(code)
      }).catch((err: unknown) => {
        log.error({ err }, 'requestPairingCode failed — will fall back to QR')
        // Reset so a manual retry from /admin/whatsapp/pair can try again.
        pairingCodeRequested = false
      })
    }

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
    if (type !== 'notify') return
    for (const m of messages) {
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
      await sock.sendMessage(jid, { text })
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
