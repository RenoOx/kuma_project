import { rm } from 'node:fs/promises'
import { serve } from '@hono/node-server'
import { app } from './app.js'
import { env } from './config/env.js'
import { logger } from './config/logger.js'
import * as businessRepo from './modules/business/business.repo.js'
import { makeWhatsappClient } from './modules/whatsapp/baileys.client.js'
import { handleIncomingCall } from './modules/whatsapp/callHandler.js'
import {
  getClient,
  getConnectionState,
  registerClient,
  setConnectionStatus,
  storePairingCode,
  storeQR,
} from './modules/whatsapp/clientRegistry.js'
import { handleIncomingMessage } from './modules/whatsapp/handler.js'
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
    // A successful link proves the number is healthy: drop the backoff counter
    // and clear any accumulated rate-limit state for it.
    reconnectAttempts.delete(businessId)
    qrPairingCycles.delete(businessId)
    cancelPendingReconnect(businessId)
    sessionGuard.recordConnected(whatsappNumber, businessId).catch((err) => {
      logger.error({ err, businessId }, 'failed to clear session guard on connect')
    })
  })

  client.onMessage((raw) => handleIncomingMessage(raw, businessId, client.sendMessage))

  client.onCall((call) =>
    handleIncomingCall(call, businessId, {
      rejectCall: client.rejectCall,
      send: client.sendMessage,
    }),
  )

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

async function bootWhatsapp(): Promise<void> {
  const allBusinesses = await businessRepo.findAll()

  if (allBusinesses.length === 0) {
    logger.info('no businesses in DB — skipping whatsapp boot (create one via admin API)')
    return
  }

  logger.info({ count: allBusinesses.length }, 'booting whatsapp clients')

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

    logger.info(
      { businessId: business.id, name: business.name, whatsappNumber: business.whatsappNumber },
      'booting whatsapp client for business',
    )
    startWhatsappFor(business.id, business.whatsappNumber).catch((err) => {
      logger.error({ err, businessId: business.id }, 'whatsapp boot failed for business')
    })
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

const shutdown = (signal: string): void => {
  logger.info({ signal }, 'received shutdown signal')
  server.close(() => {
    logger.info('server closed')
    process.exit(0)
  })
  setTimeout(() => {
    logger.error('forced shutdown after timeout')
    process.exit(1)
  }, 10_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception')
  process.exit(1)
})

process.on('unhandledRejection', (reason) => {
  logger.fatal({ reason }, 'unhandled rejection')
  process.exit(1)
})
