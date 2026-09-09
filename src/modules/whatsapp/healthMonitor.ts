import { logger } from '@/config/logger.js'
import * as clientRegistry from './clientRegistry.js'
import { getSendHealth } from './sendTelemetry.js'

// Periodic visibility for numbers that are down.
//
// This does NOT recycle anything. Baileys already tears down a socket that has
// gone quiet at the protocol level — its keep-alive checks every 30s and ends
// the connection with connectionLost once nothing has arrived for ~35s, which
// lands in the reconnect path with its backoff and its finite budget.
//
// What was actually missing is that nobody FINDS OUT. A number whose reconnect
// budget ran out, or one the session guard is holding back, sits there until a
// customer complains to the owner. Recycling on silence would be worse than
// useless: a business with no messages at 3am is normal, and forcing reconnects
// through the night is exactly what gets a number rate-limited.

const log = logger.child({ component: 'whatsapp.health' })

export const HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000
// Below this, a gap is just a reconnect doing its job. Above it, somebody
// should be looking.
export const DOWN_ALERT_THRESHOLD_MS = 10 * 60 * 1000

export interface WhatsappHealth {
  total: number
  connected: number
  disconnected: number
  /** Longest current outage across all numbers, in whole minutes. */
  longestDowntimeMinutes: number
  /** Numbers whose outbound sends are failing enough to suspect a soft ban. */
  degradedSending: number
}

/**
 * Aggregate health, with no per-tenant detail.
 *
 * Shaped for an unauthenticated caller on purpose: /health must not enumerate
 * which businesses exist, let alone their numbers or session state.
 */
export function summarize(now: number = Date.now()): WhatsappHealth {
  const snapshots = clientRegistry.getConnectionSnapshots()
  let connected = 0
  let longestDowntimeMs = 0

  for (const snapshot of snapshots) {
    if (snapshot.status === 'connected') {
      connected++
      continue
    }
    longestDowntimeMs = Math.max(longestDowntimeMs, now - snapshot.statusSince)
  }

  return {
    total: snapshots.length,
    connected,
    disconnected: snapshots.length - connected,
    longestDowntimeMinutes: Math.floor(longestDowntimeMs / 60_000),
    degradedSending: getSendHealth(now).filter((h) => h.degraded).length,
  }
}

/**
 * One sweep: an error line per number that has been down long enough to matter.
 *
 * Logged at `error` deliberately — this is the line a Railway log alert should
 * fire on, and it is the only automated way anyone learns a client's WhatsApp
 * has been offline for an hour.
 */
export function checkNow(now: number = Date.now()): void {
  for (const snapshot of clientRegistry.getConnectionSnapshots()) {
    if (snapshot.status === 'connected') continue

    const downForMs = now - snapshot.statusSince
    if (downForMs < DOWN_ALERT_THRESHOLD_MS) continue

    log.error(
      {
        businessId: snapshot.businessId,
        status: snapshot.status,
        downForMinutes: Math.floor(downForMs / 60_000),
        lastEventAt: snapshot.lastEventAt ? new Date(snapshot.lastEventAt).toISOString() : null,
      },
      'whatsapp number has been offline past the alert threshold — a human needs to look at it',
    )
  }

  // Connected but not delivering is its own failure mode, and a quieter one: the
  // socket looks healthy on every dashboard while WhatsApp refuses the messages.
  for (const health of getSendHealth(now)) {
    if (!health.degraded) continue
    log.error(
      {
        businessId: health.businessId,
        attempts: health.attempts,
        failures: health.failures,
        failureRate: health.failureRate,
        rateLimitedHits: health.rateLimitedHits,
      },
      'whatsapp sends are degraded for this number — treat as a possible soft ban',
    )
  }
}

/** Starts the sweep. Unref'd so it never holds the process open on shutdown. */
export function startHealthMonitor(): NodeJS.Timeout {
  const timer = setInterval(() => {
    try {
      checkNow()
    } catch (err) {
      log.error({ err }, 'whatsapp health sweep threw')
    }
  }, HEALTH_CHECK_INTERVAL_MS)
  timer.unref()
  return timer
}
