import { logger } from '@/config/logger.js'

// Outbound health per business number.
//
// WhatsApp rarely bans without warning: it starts refusing sends first. Every
// failure used to be logged at its own call site and forgotten there, with
// nothing aggregating the rate — so degradation was invisible right up until it
// became a ban. This is the closest thing to an early warning available from
// inside the process.
//
// Fed from the send queue, which is the single choke point every outbound
// message passes through, so no path can silently skip measurement.

const log = logger.child({ component: 'whatsapp.send-telemetry' })

const WINDOW_MS = 15 * 60 * 1000
// Below this, a failure rate is noise: one failed send out of two is 50% and
// means nothing.
const MIN_FAILURES_FOR_ALERT = 5
const FAILURE_RATE_ALERT = 0.5
// Once alerted, stay quiet for a while rather than repeating the same line on
// every subsequent send.
const ALERT_COOLDOWN_MS = 10 * 60 * 1000

export type SendErrorKind = 'rate_limited' | 'forbidden' | 'other'

export interface SendHealth {
  businessId: string
  attempts: number
  failures: number
  failureRate: number
  rateLimitedHits: number
  degraded: boolean
}

interface Attempt {
  at: number
  ok: boolean
  kind: SendErrorKind | null
}

interface Lane {
  attempts: Attempt[]
  lastAlertAt: number
}

const lanes = new Map<string, Lane>()

function laneFor(businessId: string): Lane {
  const existing = lanes.get(businessId)
  if (existing) return existing
  const lane: Lane = { attempts: [], lastAlertAt: 0 }
  lanes.set(businessId, lane)
  return lane
}

function prune(lane: Lane, now: number): void {
  while (lane.attempts.length > 0 && now - (lane.attempts[0]?.at ?? 0) >= WINDOW_MS) {
    lane.attempts.shift()
  }
}

/**
 * Names the failure, when WhatsApp gave us something nameable.
 *
 * `rate_limited` and `forbidden` are the two that matter: they are WhatsApp
 * telling us to stop, and one occurrence is already worth an alert. Everything
 * else — a dropped socket, a timeout — is ordinary and only interesting in
 * aggregate.
 */
export function classifySendError(err: unknown): SendErrorKind {
  const status = (err as { output?: { statusCode?: unknown } } | null)?.output?.statusCode
  if (status === 429) return 'rate_limited'
  if (status === 403 || status === 401) return 'forbidden'

  const message = err instanceof Error ? err.message.toLowerCase() : String(err ?? '').toLowerCase()
  if (message.includes('rate-overlimit') || message.includes('rate overlimit'))
    return 'rate_limited'
  if (message.includes('not-authorized') || message.includes('forbidden')) return 'forbidden'
  return 'other'
}

/**
 * Records one send attempt and raises the alarm when the picture is bad.
 *
 * Never throws: this is bookkeeping wrapped around a message someone is waiting
 * on, and it must not be able to take that message down.
 */
export function recordSendResult(businessId: string, ok: boolean, err?: unknown): void {
  try {
    const now = Date.now()
    const lane = laneFor(businessId)
    const kind = ok ? null : classifySendError(err)

    lane.attempts.push({ at: now, ok, kind })
    prune(lane, now)

    // A single one of these is WhatsApp telling us to back off. It does not wait
    // for a rate to build up, because by then the number is already in trouble.
    if (kind === 'rate_limited' || kind === 'forbidden') {
      log.error(
        { businessId, kind, err },
        'whatsapp refused a send — this is the signal that precedes a ban, stop sending from this number and investigate',
      )
      lane.lastAlertAt = now
      return
    }

    const failures = lane.attempts.filter((a) => !a.ok).length
    if (failures < MIN_FAILURES_FOR_ALERT) return
    if (failures / lane.attempts.length < FAILURE_RATE_ALERT) return
    if (now - lane.lastAlertAt < ALERT_COOLDOWN_MS) return

    lane.lastAlertAt = now
    log.error(
      {
        businessId,
        attempts: lane.attempts.length,
        failures,
        failureRate: Number((failures / lane.attempts.length).toFixed(2)),
        windowMinutes: WINDOW_MS / 60_000,
      },
      'whatsapp sends are failing at a high rate for this number — possible soft ban',
    )
  } catch (telemetryErr) {
    log.warn({ err: telemetryErr, businessId }, 'send telemetry failed to record a result')
  }
}

/** Per-number outbound health over the rolling window. */
export function getSendHealth(now: number = Date.now()): SendHealth[] {
  const out: SendHealth[] = []
  for (const [businessId, lane] of lanes) {
    prune(lane, now)
    if (lane.attempts.length === 0) continue

    const failures = lane.attempts.filter((a) => !a.ok).length
    const rateLimitedHits = lane.attempts.filter(
      (a) => a.kind === 'rate_limited' || a.kind === 'forbidden',
    ).length
    const failureRate = failures / lane.attempts.length

    out.push({
      businessId,
      attempts: lane.attempts.length,
      failures,
      failureRate: Number(failureRate.toFixed(2)),
      rateLimitedHits,
      degraded:
        rateLimitedHits > 0 ||
        (failures >= MIN_FAILURES_FOR_ALERT && failureRate >= FAILURE_RATE_ALERT),
    })
  }
  return out
}
