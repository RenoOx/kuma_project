import { logger as rootLogger } from '@/config/logger.js'
import {
  makeWASocket,
  Browsers,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import type { Boom } from '@hapi/boom'
import { mkdir } from 'node:fs/promises'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { classifyDisconnect, disconnectReasonName, type DisconnectKind } from './sessionPolicy.js'

export type MessageHandler = (raw: WAMessage) => Promise<void> | void
export interface DisconnectInfo {
  kind: DisconnectKind
  statusCode: number | undefined
  reasonName: string
  errMessage: string | undefined
}
export type DisconnectHandler = (info: DisconnectInfo) => void
export type QRHandler = (qr: string) => void
export type ConnectHandler = () => void
export type PairingCodeHandler = (code: string) => void
export interface IncomingCall {
  id: string
  from: string
  isVideo: boolean
}
export type CallHandler = (call: IncomingCall) => Promise<void> | void

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
  onCall(handler: CallHandler): void
  /** Hangs up an incoming call so the caller isn't left ringing. */
  rejectCall(callId: string, callFrom: string): Promise<void>
  requestPairingCode(phoneNumber: string): Promise<string>
  /**
   * Tears the socket down on purpose. Suppresses the disconnect handlers so a
   * deliberate close never looks like a drop and never triggers a reconnect —
   * without this, replacing a client stacks live sockets that all keep talking
   * to WhatsApp with the same number.
   */
  close(): Promise<void>
  /**
   * Unlinks this device from the customer's WhatsApp account, then closes.
   *
   * `close()` only drops our end of the socket: WhatsApp still lists the device
   * on the owner's phone under "Dispositivos vinculados". This tells WhatsApp we
   * are leaving, which is what offboarding a customer actually requires.
   *
   * Irreversible — coming back needs a fresh QR scan.
   */
  logout(): Promise<void>
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
  const callHandlers: CallHandler[] = []
  let intentionallyClosed = false

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update
    log.info({ connection, hasQr: !!qr }, 'connection.update')

    if (intentionallyClosed) return

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
      const kind = classifyDisconnect(statusCode)
      const reasonName = disconnectReasonName(statusCode)
      log.warn({ statusCode, errMessage, kind, reasonName }, 'whatsapp connection closed')
      for (const handler of disconnectHandlers) handler({ kind, statusCode, reasonName, errMessage })
    }
  })

  // A single call raises several events (offer → ringing → timeout/terminate).
  // Only the initial offer is actionable; the rest would fan out into duplicate
  // replies to the same caller.
  sock.ev.on('call', async (calls) => {
    if (intentionallyClosed) return
    for (const call of calls) {
      if (call.status !== 'offer') continue
      log.info({ callId: call.id, from: call.from, isVideo: call.isVideo }, 'incoming call offer')
      for (const handler of callHandlers) {
        try {
          await handler({ id: call.id, from: call.from, isVideo: call.isVideo === true })
        } catch (err) {
          log.error({ err, callId: call.id }, 'call handler threw')
        }
      }
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
    onCall(handler) {
      callHandlers.push(handler)
    },
    async rejectCall(callId, callFrom) {
      await sock.rejectCall(callId, callFrom)
    },
    async requestPairingCode(phoneNumber: string): Promise<string> {
      const digits = phoneNumber.replace(/\D/g, '')
      return sock.requestPairingCode(digits)
    },
    async close() {
      if (intentionallyClosed) return
      // Flip the flag BEFORE ending the socket: sock.end() emits a close event
      // synchronously, and it must not reach the disconnect handlers.
      intentionallyClosed = true
      messageHandlers.length = 0
      disconnectHandlers.length = 0
      qrHandlers.length = 0
      connectHandlers.length = 0
      pairingCodeHandlers.length = 0
      callHandlers.length = 0
      try {
        sock.end(undefined)
      } catch (err) {
        log.warn({ err }, 'sock.end threw while closing — socket considered dead anyway')
      }
      try {
        sock.ev.removeAllListeners('connection.update')
        sock.ev.removeAllListeners('messages.upsert')
        sock.ev.removeAllListeners('creds.update')
        sock.ev.removeAllListeners('call')
      } catch (err) {
        log.warn({ err }, 'removeAllListeners threw while closing')
      }
      log.info('whatsapp client closed intentionally')
    },
    async logout() {
      // Same ordering rule as close(): sock.logout() makes WhatsApp answer with
      // a loggedOut (401) disconnect, which classifyDisconnect routes to `halt`
      // and would end up in recordHalt marking this number. Suppress the
      // handlers FIRST so our own deliberate logout is never mistaken for
      // WhatsApp punishing us.
      if (intentionallyClosed) return
      intentionallyClosed = true
      messageHandlers.length = 0
      disconnectHandlers.length = 0
      qrHandlers.length = 0
      connectHandlers.length = 0
      pairingCodeHandlers.length = 0
      callHandlers.length = 0

      try {
        await sock.logout()
        log.warn('whatsapp device unlinked via logout — credentials are now invalid')
      } finally {
        // Runs even when logout throws: an unreachable WhatsApp must not leave
        // a live socket behind still answering that business's customers.
        try {
          sock.end(undefined)
        } catch (err) {
          log.warn({ err }, 'sock.end threw after logout — socket considered dead anyway')
        }
        try {
          sock.ev.removeAllListeners('connection.update')
          sock.ev.removeAllListeners('messages.upsert')
          sock.ev.removeAllListeners('creds.update')
          sock.ev.removeAllListeners('call')
        } catch (err) {
          log.warn({ err }, 'removeAllListeners threw after logout')
        }
      }
    },
  }
}
