import { mkdir } from 'node:fs/promises'
import type { Boom } from '@hapi/boom'
import {
  Browsers,
  fetchLatestBaileysVersion,
  makeWASocket,
  type proto,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'
import { env } from '@/config/env.js'
import { logger as rootLogger } from '@/config/logger.js'
import { withTimeout } from '@/shared/withTimeout.js'
import { classifyDisconnect, type DisconnectKind, disconnectReasonName } from './sessionPolicy.js'

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
  /**
   * Relays a photo. Separate from sendMessage rather than an overload because
   * the payload shape Baileys wants is different, but it runs through the same
   * LID handshake — an owner paired after the LID migration is reachable only
   * at an `@lid` jid, and a raw send there fails with 463.
   */
  sendImage(jid: string, image: Buffer, caption?: string): Promise<void>
  /**
   * Relays a file as a document: a catalogue, a price list, a brochure.
   *
   * `fileName` is what the customer sees in the chat and what their phone saves
   * it as, so it carries the owner's original name rather than the storage id.
   * `mimetype` is the sniffed one, never anything the uploader claimed.
   */
  sendDocument(
    jid: string,
    document: Buffer,
    mimetype: string,
    fileName: string,
    caption?: string,
  ): Promise<void>
  /**
   * Relays audio.
   *
   * `ptt: false` on purpose — this arrives as a playable audio file, not as a
   * voice note. A voice note claims a person recorded it just then, which is a
   * thing Emma must never imply.
   */
  sendAudio(jid: string, audio: Buffer, mimetype: string): Promise<void>
  /** Relays a video, with an optional caption like an image. */
  sendVideo(jid: string, video: Buffer, caption?: string): Promise<void>
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

// How many outgoing message protos to keep around for retry requests. A
// retry lands within seconds of the original, so this only has to cover a
// short burst — it is not a transcript.
const SENT_MESSAGE_CACHE_MAX = 500

export async function makeWhatsappClient(opts: WhatsappClientOptions): Promise<WhatsappClient> {
  const log = rootLogger.child({ component: 'baileys', businessId: opts.businessId })

  await mkdir(opts.sessionDir, { recursive: true })
  const { state, saveCreds } = await useMultiFileAuthState(opts.sessionDir)

  // Was pinned to `info` while prod pairing was being stabilised. That is done,
  // and at `info` Baileys narrates every frame it handles — on a busy number
  // that is the bulk of the log volume, and volume is what fills a Railway
  // volume. Protocol failures (stream errors, disconnect reasons) are `warn` and
  // above, so nothing diagnostic is lost.
  const baileysLogger = pino({ level: env.NODE_ENV === 'production' ? 'warn' : 'info' })

  // WhatsApp's server rejects the handshake with a generic 500 if the client
  // doesn't announce a WA-Web version it accepts and a recognizable browser
  // identifier. fetchLatestBaileysVersion pulls the currently-supported one.
  const { version } = await fetchLatestBaileysVersion()
  log.info({ version }, 'using whatsapp web version')

  // Protos of the messages we sent, newest last, so Baileys can re-serve one
  // when a recipient asks for a retry.
  //
  // Scoped to THIS socket and never module-level: the key is WhatsApp's message
  // id, and a shared map would make one business's message content readable
  // through another business's socket.
  const sentMessages = new Map<string, proto.IMessage>()

  function rememberSentMessage(
    id: string | null | undefined,
    message: proto.IMessage | null | undefined,
  ): void {
    if (!id || !message) return
    // Map iterates in insertion order, so the first key is the oldest.
    if (sentMessages.size >= SENT_MESSAGE_CACHE_MAX) {
      const oldest = sentMessages.keys().next().value
      if (oldest !== undefined) sentMessages.delete(oldest)
    }
    sentMessages.set(id, message)
  }

  const sock = makeWASocket({
    auth: state,
    logger: baileysLogger,
    version,
    browser: Browsers.macOS('Desktop'),
    // Skip the full history sync on connect — we only need incoming messages
    // from now on, not the entire chat history.
    syncFullHistory: false,
    // Belt and braces on top of syncFullHistory. WhatsApp still pushes history
    // sync notifications during linking, and every one we accept is traffic and
    // decryption work for messages this bot will never read.
    shouldSyncHistoryMessage: () => false,
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
    // 60s default so a slow WA response doesn't kill the socket. Set together
    // with fireInitQueries during the 2026-07-01 pairing incident, where the
    // stream was being torn down every few minutes.
    //
    // Kept high ON PURPOSE, and not the right knob for "a query hung and blocked
    // something": this value protects the connection, while the calls that sit
    // in serialized critical paths carry their own short timeouts (see
    // prepareLidSession below, and the reachability check in sendReminders).
    // Lowering this instead would trade a real, fixed incident for a problem
    // those local timeouts already solve.
    defaultQueryTimeoutMs: 180_000,
    // Emit own outgoing messages back through the event stream. Not needed
    // for the bot; keeping it off reduces noise on the handler.
    emitOwnEvents: false,
    // Called when a recipient could not decrypt one of our messages and asks
    // for a retry. Returning undefined loses that message for good — the
    // patient is left on "Esperando este mensaje" — and leaves their client
    // retrying, and repeated decryption failures are a session-health signal
    // WhatsApp counts against the number.
    getMessage: async (key) => (key.id ? sentMessages.get(key.id) : undefined),
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
      log.info('whatsapp QR ready — open /admin/whatsapp/qr to scan it')
      // A QR is a session credential: anyone who can read the log stream can
      // scan it and link their own device to the customer's WhatsApp. It belongs
      // on the authenticated admin page, never in stdout. Kept for local
      // development, where the terminal IS the operator's screen.
      //
      // It also stops the ASCII block from being reprinted every ~20s for up to
      // twenty pairing cycles.
      if (env.NODE_ENV === 'development') qrcode.generate(qr, { small: true })
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
      for (const handler of disconnectHandlers)
        handler({ kind, statusCode, reasonName, errMessage })
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

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    log.info({ type, count: messages.length }, 'messages.upsert received')
    if (type !== 'notify') return
    for (const m of messages) {
      // debug, not info: the batch line above already records that traffic
      // arrived and how much. This per-message shape dump is a development aid,
      // and in production it doubled the log lines for every single message.
      log.debug(
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
        // NOT awaited. The handler serialises its own work per sender, so
        // awaiting here only queued unrelated customers behind each other's
        // debounce window and LLM call — on the offline backlog WhatsApp
        // delivers after a reconnect, that was minutes of silence for whoever
        // came last in the batch.
        //
        // Safe because of two things that did not exist when this loop was
        // written: the send queue rate-limits the outbound side, so the fan-out
        // cannot become a burst, and the handler caps how many messages it
        // processes at once. Dedup is unaffected — claimMessageId runs in the
        // handler's synchronous prologue, before any await.
        try {
          void Promise.resolve(handler(m)).catch((err) => {
            log.error({ err }, 'message handler rejected')
          })
        } catch (err) {
          log.error({ err }, 'message handler threw synchronously')
        }
      }
    }
  })

  // LID recipients require the sender to have E2E key material fetched and a
  // signal session established. assertSessions alone often isn't enough because
  // WA delays returning key material until presence is subscribed. Pattern that
  // works: presenceSubscribe → delay → assertSessions → send.
  //
  // Both queries are bounded well below defaultQueryTimeoutMs. That 3-minute
  // leash exists so a slow init query cannot tear the stream down, but this runs
  // inside a send-queue lane: a query hanging on the global timeout would stall
  // every other message for that business for three minutes. Ten seconds is more
  // than a healthy handshake needs, and both failures already degrade into
  // "send anyway".
  const LID_QUERY_TIMEOUT_MS = 10_000

  async function prepareLidSession(jid: string): Promise<void> {
    if (!jid.endsWith('@lid')) return
    try {
      await withTimeout(sock.presenceSubscribe(jid), LID_QUERY_TIMEOUT_MS, 'presenceSubscribe')
      log.info({ jid }, 'presenceSubscribe ok for lid')
    } catch (err) {
      log.warn({ err, jid }, 'presenceSubscribe failed')
    }
    await new Promise((r) => setTimeout(r, 800))
    try {
      await withTimeout(sock.assertSessions([jid], true), LID_QUERY_TIMEOUT_MS, 'assertSessions')
      log.info({ jid }, 'assertSessions ok for lid')
    } catch (err) {
      log.warn({ err, jid }, 'assertSessions failed — send may still 463')
    }
  }

  return {
    sock,
    async sendMessage(jid, text) {
      log.info({ jid, textLen: text.length }, 'sock.sendMessage: calling')
      await prepareLidSession(jid)
      const result = await sock.sendMessage(jid, { text })
      rememberSentMessage(result?.key?.id, result?.message)
      log.info(
        { jid, hasResult: !!result, messageId: result?.key?.id, status: result?.status },
        'sock.sendMessage: returned',
      )
    },
    async sendImage(jid, image, caption) {
      log.info({ jid, bytes: image.length, hasCaption: !!caption }, 'sock.sendImage: calling')
      await prepareLidSession(jid)
      const result = await sock.sendMessage(jid, {
        image,
        ...(caption ? { caption } : {}),
      })
      rememberSentMessage(result?.key?.id, result?.message)
      log.info(
        { jid, hasResult: !!result, messageId: result?.key?.id, status: result?.status },
        'sock.sendImage: returned',
      )
    },
    // The three below are sendImage with a different payload key. Same LID
    // handshake, same rememberSentMessage, same logging — a media send that
    // skipped prepareLidSession would 463 against an owner paired after the LID
    // migration, and one that skipped rememberSentMessage would come back as an
    // unrecognised echo.
    async sendDocument(jid, document, mimetype, fileName, caption) {
      log.info({ jid, bytes: document.length, mimetype, fileName }, 'sock.sendDocument: calling')
      await prepareLidSession(jid)
      const result = await sock.sendMessage(jid, {
        document,
        mimetype,
        fileName,
        ...(caption ? { caption } : {}),
      })
      rememberSentMessage(result?.key?.id, result?.message)
      log.info(
        { jid, hasResult: !!result, messageId: result?.key?.id, status: result?.status },
        'sock.sendDocument: returned',
      )
    },
    async sendAudio(jid, audio, mimetype) {
      log.info({ jid, bytes: audio.length, mimetype }, 'sock.sendAudio: calling')
      await prepareLidSession(jid)
      const result = await sock.sendMessage(jid, { audio, mimetype, ptt: false })
      rememberSentMessage(result?.key?.id, result?.message)
      log.info(
        { jid, hasResult: !!result, messageId: result?.key?.id, status: result?.status },
        'sock.sendAudio: returned',
      )
    },
    async sendVideo(jid, video, caption) {
      log.info({ jid, bytes: video.length, hasCaption: !!caption }, 'sock.sendVideo: calling')
      await prepareLidSession(jid)
      const result = await sock.sendMessage(jid, {
        video,
        ...(caption ? { caption } : {}),
      })
      rememberSentMessage(result?.key?.id, result?.message)
      log.info(
        { jid, hasResult: !!result, messageId: result?.key?.id, status: result?.status },
        'sock.sendVideo: returned',
      )
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
      // Patient message content must not outlive the socket that sent it.
      sentMessages.clear()
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
      sentMessages.clear()

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
