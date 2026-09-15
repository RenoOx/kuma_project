import { rm } from 'node:fs/promises'
import { serve } from '@hono/node-server'
import { app } from './app.js'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import * as businessRepo from './modules/business/business.repo.js'
import { inspectAuthState, logSessionsDirDiagnostics } from './modules/whatsapp/authState.js'
import { makeWhatsappClient } from './modules/whatsapp/baileys.client.js'
import { handleIncomingCall } from './modules/whatsapp/callHandler.js'
import {
  getAllClients,
  getClient,
  getConnectionState,
  registerClient,
  setConnectionStatus,
  storePairingCode,
  storeQR,
  touchActivity,
} from './modules/whatsapp/clientRegistry.js'
import { handleIncomingMessage } from './modules/whatsapp/handler.js'
import { HEALTH_CHECK_INTERVAL_MS, startHealthMonitor } from './modules/whatsapp/healthMonitor.js'
import * as presence from './modules/whatsapp/presence.js'
import { stopQueue } from './modules/whatsapp/sendQueue.js'
import * as sessionGuard from './modules/whatsapp/sessionGuard.service.js'
import {
  hasExhaustedReconnects,
  MAX_QR_PAIRING_CYCLES,
  MAX_RECONNECT_ATTEMPTS,
  QR_PAIRING_RETRY_DELAY_MS,
  RESTART_REQUIRED_DELAY_MS,
  reconnectDelayMs,
} from './modules/whatsapp/sessionPolicy.js'
import { cleanupOwnerThreadMessages } from './workers/cleanupOwnerThread.js'
import { runTakeoverTimeoutGuarded } from './workers/takeoverTimeout.js'
import { sendDueReminders } from './workers/sendReminders.js'

const server = serve(
  {
    fetch: app.fetch,
    port: env.PORT,
  },
  (info) => {
    logger.info({ port: info.port, env: env.NODE_ENV }, 'kuma server listening')
  },
)

// Transient-drop reconnect counters, per business. Reset on a successful
// connection so a healthy socket that blips months later gets a full budget.
const reconnectAttempts = new Map<string, number>()
const reconnectTimers = new Map<string, NodeJS.Timeout>()
// Counted apart from reconnectAttempts: an expired QR is not a failure.
const qrPairingCycles = new Map<string, number>()

function cancelPendingReconnect(businessId: string): void {
  const timer = reconnectTimers.get(businessId)
  if (timer) {
    clearTimeout(timer)
    reconnectTimers.delete(businessId)
  }
}

function scheduleReconnect(businessId: string, whatsappNumber: string, delayMs: number): void {
  cancelPendingReconnect(businessId)
  const timer = setTimeout(() => {
    reconnectTimers.delete(businessId)
    startWhatsappFor(businessId, whatsappNumber).catch((err) => {
      logger.error({ err, businessId }, 'whatsapp reconnect failed')
    })
  }, delayMs)
  timer.unref()
  reconnectTimers.set(businessId, timer)
}

async function startWhatsappFor(businessId: string, whatsappNumber: string): Promise<void> {
  const sessionDir = `${env.SESSIONS_DIR}/${businessId}`

  // Never stack sockets. Without this, every restart leaves the old socket
  // alive with its own reconnect timer while registerClient makes it
  // unreachable — N live sockets all hammering WhatsApp with the same number
  // is exactly what gets a number banned.
  const previous = getClient(businessId)
  if (previous) {
    logger.info({ businessId }, 'closing previous whatsapp client before booting a new one')
    await previous.close()
  }
  cancelPendingReconnect(businessId)
  // Drop any presence timer left over from the socket being replaced: it would
  // fire against a socket that no longer exists.
  presence.stopPresence(businessId)

  const client = await makeWhatsappClient({ businessId, sessionDir })

  // Register the live client for proactive notifications. We register on
  // EVERY boot (including reconnects below), because the underlying socket
  // reference is fresh after a reconnect and the old one would silently
  // fail to send.
  registerClient(businessId, client)

  client.onQR((qr) => {
    storeQR(businessId, qr)
    logger.info({ businessId }, 'whatsapp QR stored — visit /admin/whatsapp/qr to scan')
  })

  client.onPairingCode((code) => {
    storePairingCode(businessId, code)
    logger.info({ businessId }, 'pairing code stored — visit /admin/whatsapp/pair to see it')
  })

  client.onConnect(() => {
    setConnectionStatus(businessId, 'connected')
    touchActivity(businessId)
    presence.scheduleInitialPresence(businessId)
    // A successful link proves the number is healthy: drop the backoff counter
    // and clear any accumulated rate-limit state for it.
    reconnectAttempts.delete(businessId)
    qrPairingCycles.delete(businessId)
    cancelPendingReconnect(businessId)
    sessionGuard.recordConnected(whatsappNumber, businessId).catch((err) => {
      logger.error({ err, businessId }, 'failed to clear session guard on connect')
    })
  })

  client.onMessage((raw) => {
    touchActivity(businessId)
    return handleIncomingMessage(raw, businessId, client.sendMessage)
  })

  client.onCall((call) => {
    touchActivity(businessId)
    return handleIncomingCall(call, businessId, {
      rejectCall: client.rejectCall,
      send: client.sendMessage,
    })
  })

  client.onDisconnect((info) => {
    if (info.kind === 'halt') {
      // HALT. WA revoked these creds, banned us, or handed the session to
      // someone else. Retrying is not just useless, it is dangerous — repeated
      // failures escalate WA rate-limits and can ban the number outright. The
      // guard persists the block so neither an operator click nor a Railway
      // redeploy can re-hammer it before the cool-off passes.
      setConnectionStatus(businessId, 'logged_out')
      reconnectAttempts.delete(businessId)
      cancelPendingReconnect(businessId)
      sessionGuard.recordHalt(whatsappNumber, businessId, info.reasonName).catch((err) => {
        logger.error({ err, businessId }, 'failed to persist whatsapp halt')
      })
      logger.error(
        { businessId, sessionDir, statusCode: info.statusCode, reasonName: info.reasonName },
        'whatsapp HALTED — do NOT redeploy to retry (each attempt extends the WA rate-limit). Wait out the block, then use the resume endpoint',
      )
      return
    }

    if (info.kind === 'restart_required') {
      // Normal step of the pairing handshake, not a failure: WhatsApp asks for
      // a reconnect right after linking succeeds. No backoff, no attempt spent.
      logger.info({ businessId }, 'whatsapp asked for a restart — reconnecting immediately')
      scheduleReconnect(businessId, whatsappNumber, RESTART_REQUIRED_DELAY_MS)
      return
    }

    // Still waiting for someone to scan the QR? Then this close is just the code
    // expiring, not a fault. Re-issue a fresh QR on its own budget so the
    // operator isn't punished for taking a minute to grab their phone.
    const pairing = getConnectionState(businessId)?.status === 'qr_pending'
    if (pairing) {
      const cycle = (qrPairingCycles.get(businessId) ?? 0) + 1
      if (cycle > MAX_QR_PAIRING_CYCLES) {
        setConnectionStatus(businessId, 'logged_out')
        qrPairingCycles.delete(businessId)
        sessionGuard
          .recordSessionStopped(whatsappNumber, businessId, `qr_not_scanned:${info.reasonName}`)
          .catch((err) => {
            logger.error({ err, businessId }, 'failed to persist qr pairing stop')
          })
        logger.warn(
          { businessId, cycles: MAX_QR_PAIRING_CYCLES },
          'QR went unscanned for the whole window — stopping. Press Conectar to try again (number NOT blocked)',
        )
        return
      }
      qrPairingCycles.set(businessId, cycle)
      logger.info(
        { businessId, cycle, maxCycles: MAX_QR_PAIRING_CYCLES },
        'QR expired unscanned — issuing a fresh one',
      )
      scheduleReconnect(businessId, whatsappNumber, QR_PAIRING_RETRY_DELAY_MS)
      return
    }

    // Transient drop (network hiccup, WA server blip) — credentials are still
    // valid, so reconnect with exponential backoff and a finite budget.
    const attempt = (reconnectAttempts.get(businessId) ?? 0) + 1
    if (hasExhaustedReconnects(attempt)) {
      setConnectionStatus(businessId, 'logged_out')
      reconnectAttempts.delete(businessId)
      // Giving up reconnecting is not abuse — no cool-off. The ban budget is
      // spent by pairing codes and restarts, which are counted on their own.
      sessionGuard
        .recordSessionStopped(
          whatsappNumber,
          businessId,
          `reconnect_budget_exhausted:${info.reasonName}`,
        )
        .catch((err) => {
          logger.error({ err, businessId }, 'failed to persist reconnect exhaustion')
        })
      logger.error(
        { businessId, attempts: MAX_RECONNECT_ATTEMPTS, reasonName: info.reasonName },
        'whatsapp reconnect budget exhausted — giving up instead of hammering WA (number NOT blocked)',
      )
      return
    }

    reconnectAttempts.set(businessId, attempt)
    const delayMs = reconnectDelayMs(attempt)
    logger.warn(
      {
        businessId,
        attempt,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        delayMs,
        reasonName: info.reasonName,
      },
      'whatsapp dropped, scheduling reconnect with backoff',
    )
    scheduleReconnect(businessId, whatsappNumber, delayMs)
  })
}

// Exposed so the admin resume endpoint can restart a business on explicit
// operator action. Clears the stale session before booting.
//
// The guard check lives HERE, not only in the routes, so no caller can bypass
// it. Throws SessionGuardError when the number is cooling down or blocked —
// callers render that as a countdown rather than firing at WhatsApp.
export async function restartWhatsappFor(
  businessId: string,
  whatsappNumber: string,
): Promise<void> {
  await sessionGuard.assertCanRestart(whatsappNumber)
  await sessionGuard.recordRestart(whatsappNumber, businessId)

  const sessionDir = `${env.SESSIONS_DIR}/${businessId}`
  await rm(sessionDir, { recursive: true, force: true })
  reconnectAttempts.delete(businessId)
  qrPairingCycles.delete(businessId)
  logger.info({ businessId, sessionDir }, 'manual resume: session cleared, booting fresh client')
  return startWhatsappFor(businessId, whatsappNumber)
}

// Spacing between the first connection of each business at boot. N handshakes
// from one Railway IP on the same second is a pattern; the same N spread over
// minutes is a server coming up. Tracked so a redeploy landing mid-boot does not
// leave timers firing handshakes for a process that is already shutting down.
const BOOT_STAGGER_MS = 15_000
const bootTimers: NodeJS.Timeout[] = []

function cancelPendingBoots(): void {
  for (const timer of bootTimers) clearTimeout(timer)
  bootTimers.length = 0
}

async function bootWhatsapp(): Promise<void> {
  const allBusinesses = await businessRepo.findAll()

  if (allBusinesses.length === 0) {
    logger.info('no businesses in DB — skipping whatsapp boot (create one via admin API)')
    return
  }

  logger.info({ count: allBusinesses.length }, 'booting whatsapp clients')

  // Printed once, before any socket: if the volume is not mounted where
  // SESSIONS_DIR points, this is the line in the deploy log that says so.
  await logSessionsDirDiagnostics(env.SESSIONS_DIR)

  for (const business of allBusinesses) {
    // A redeploy must never re-attempt a number WhatsApp is currently punishing.
    // This used to depend on a human reading a log line; now the block is data.
    //
    // Fail OPEN on a read error, per business. An unreadable guard is an
    // infrastructure problem, not evidence of a ban — and booting with existing
    // credentials is not a pairing attempt, so it does not hammer WhatsApp. The
    // paths that actually burn a number (restart, pairing code) do their own
    // check and fail closed. Without this, a missing table or a DB blip would
    // take every business offline at once.
    let status: Awaited<ReturnType<typeof sessionGuard.getStatus>> | null = null
    try {
      status = await sessionGuard.getStatus(business.whatsappNumber)
    } catch (err) {
      logger.error(
        { err, businessId: business.id },
        'session guard unreadable at boot — booting anyway (guard still protects restart/pairing)',
      )
    }

    // Fail CLOSED on a broken auth state, the same way the guard fails closed
    // on the paths that burn a number. Booting anyway would hand the operator a
    // QR for a number that is already linked, and scanning it spends linking
    // budget on fixing something that is really a storage problem.
    //
    // 'absent' is NOT this case: a business that has never been linked has no
    // credentials by definition, and it has to boot to produce its first QR.
    const authState = await inspectAuthState(`${env.SESSIONS_DIR}/${business.id}`)
    if (authState.status === 'corrupt') {
      setConnectionStatus(business.id, 'logged_out')
      logger.error(
        {
          businessId: business.id,
          name: business.name,
          reason: authState.reason,
          sessionDir: `${env.SESSIONS_DIR}/${business.id}`,
        },
        'skipping whatsapp boot — stored credentials are damaged. Do NOT re-pair before checking the volume: a fresh QR here spends the number linking budget on a storage fault',
      )
      continue
    }
    logger.info(
      {
        businessId: business.id,
        credentials: authState.status,
        registeredAs: authState.registeredAs,
      },
      'auth state inspected',
    )

    if (status?.blocked) {
      setConnectionStatus(business.id, 'logged_out')
      logger.warn(
        {
          businessId: business.id,
          name: business.name,
          haltReason: status.haltReason,
          blockedUntil: status.blockedUntil,
          retryAfterMs: status.retryAfterMs,
        },
        'skipping whatsapp boot — number is blocked by the session guard (retrying now risks a ban)',
      )
      continue
    }

    const delayMs = bootTimers.length * BOOT_STAGGER_MS
    logger.info(
      {
        businessId: business.id,
        name: business.name,
        whatsappNumber: business.whatsappNumber,
        delayMs,
      },
      'scheduling whatsapp client boot for business',
    )
    const timer = setTimeout(() => {
      startWhatsappFor(business.id, business.whatsappNumber).catch((err) => {
        logger.error({ err, businessId: business.id }, 'whatsapp boot failed for business')
      })
    }, delayMs)
    timer.unref()
    bootTimers.push(timer)
  }
}

bootWhatsapp().catch((err) => {
  logger.fatal({ err }, 'failed to bootstrap whatsapp')
})

// Owner-thread message cleanup. Runs every hour, deleting messages older
// than 48h in any owner_thread conversation. .unref() so the timer doesn't
// keep the process alive on its own during shutdown.
// TODO Día 11: migrar a BullMQ scheduled job cuando deployemos a Railway.
const OWNER_CLEANUP_INTERVAL_MS = 60 * 60 * 1000
setInterval(() => {
  cleanupOwnerThreadMessages().catch((err) => {
    logger.error({ err }, 'owner_thread cleanup failed')
  })
}, OWNER_CLEANUP_INTERVAL_MS).unref()
logger.info(
  { intervalMs: OWNER_CLEANUP_INTERVAL_MS },
  'owner_thread cleanup scheduled (setInterval)',
)

// Reminder worker. Polls every 15 min looking for appointments whose
// `scheduled_at` falls in the 24h or 2h reminder window AND whose matching
// `reminder_*_sent_at` column is still NULL.
// TODO V1.5: migrar a BullMQ scheduled jobs cuando incorporemos Redis.
const REMINDER_INTERVAL_MS = 15 * 60 * 1000
setInterval(() => {
  sendDueReminders().catch((err) => {
    logger.error({ err }, 'sendDueReminders job failed')
  })
}, REMINDER_INTERVAL_MS).unref()
logger.info({ intervalMs: REMINDER_INTERVAL_MS }, 'reminders worker scheduled (setInterval)')

// Hands a forgotten human takeover back to Emma after 30 minutes. Shares the
// reminders cadence because both are 15-minute sweeps with their own re-entry
// guard; kept as a separate timer so one stalling cannot delay the other.
// TODO V1.5: migrar a BullMQ scheduled jobs junto con el worker de recordatorios.
setInterval(() => {
  runTakeoverTimeoutGuarded().catch((err) => {
    logger.error({ err }, 'takeover timeout job failed')
  })
}, REMINDER_INTERVAL_MS).unref()
logger.info({ intervalMs: REMINDER_INTERVAL_MS }, 'takeover timeout worker scheduled (setInterval)')

// Offline-number alerting. Does not reconnect anything — see healthMonitor.ts
// for why recycling on silence would make things worse.
startHealthMonitor()
logger.info({ intervalMs: HEALTH_CHECK_INTERVAL_MS }, 'whatsapp health monitor scheduled')

// Railway sends SIGKILL roughly 10s after SIGTERM. The socket drain gets 8 of
// those, leaving room for the HTTP server to close after it.
const SOCKET_DRAIN_BUDGET_MS = 8_000
const HTTP_CLOSE_BUDGET_MS = 1_500

let shuttingDown = false

const shutdown = async (signal: string): Promise<void> => {
  // SIGTERM and SIGINT can both land on the same stop, and uncaughtException
  // routes in here too. Draining twice would race close() against itself.
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'received shutdown signal')

  // Before anything else: a reconnect timer — or a staggered boot still waiting
  // its turn — firing mid-drain opens a fresh socket for a process that is
  // already dying, and nothing would ever close it.
  for (const businessId of [...reconnectTimers.keys()]) cancelPendingReconnect(businessId)
  cancelPendingBoots()

  // Nothing new goes out from here on. With roughly 8s before SIGKILL there is
  // no honest way to drain a backlog, and every caller already handles a
  // rejected send by logging it.
  const dropped = stopQueue()
  if (dropped > 0) {
    logger.warn({ dropped }, 'send queue stopped — queued messages discarded on shutdown')
  }

  for (const [businessId] of getAllClients()) presence.stopPresence(businessId)

  // Closing the WhatsApp sockets is the whole point of this handler. Exiting
  // without it leaves the session registered on WhatsApp's side, so the
  // container replacing us links with the same credentials while the old device
  // is still listed — that is a 440 connectionReplaced, which classifyDisconnect
  // routes to 'halt' and recordHalt can turn into a 6h block on the customer's
  // number. close() flips intentionallyClosed before ending the socket, so none
  // of these closes is mistaken for a drop or triggers a reconnect.
  const clients = getAllClients()
  if (clients.length > 0) {
    await Promise.race([
      Promise.allSettled(
        clients.map(async ([businessId, client]) => {
          try {
            await client.close()
          } catch (err) {
            logger.warn({ err, businessId }, 'client.close threw during shutdown')
          }
        }),
      ),
      new Promise((resolve) => setTimeout(resolve, SOCKET_DRAIN_BUDGET_MS)),
    ])
    logger.info({ count: clients.length }, 'whatsapp clients drained')
  }

  server.close(() => {
    logger.info('server closed')
    process.exit(0)
  })
  setTimeout(() => {
    logger.error('forced shutdown after timeout')
    process.exit(1)
  }, HTTP_CLOSE_BUDGET_MS).unref()
}

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception — draining whatsapp sockets before exit')
  void shutdown('uncaughtException').finally(() => process.exit(1))
})

// Deliberately NOT fatal. Baileys emits stray rejections of its own (Signal
// decryption failures, IQ timeouts, internal socket errors), and exiting on one
// turns a recoverable hiccup into a container restart — which is a fresh
// WhatsApp handshake with the same credentials. Ten of those back to back is
// what rate-limited the first production number. Log it loudly, keep serving.
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled rejection — process kept alive on purpose')
})
