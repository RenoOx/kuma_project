import { logger } from '@/config/logger.js'
import { recordSendResult } from './sendTelemetry.js'

// Serialises every outbound WhatsApp message for one business number.
//
// Keyed per business and not globally on purpose: WhatsApp throttles the
// account, not our process, so the budget belongs to the number. It also means
// two tenants can never throttle each other — a clinic sending its reminders
// must not delay another clinic's live reply.
//
// In memory like clientRegistry, and with the same caveat: with one Railway
// instance the lane IS the number. Multi-instance would need this centralised,
// or each instance would enforce the limit against its own share only.

export type SendPriority = 'reply' | 'owner' | 'reminder'

// A customer waiting on an answer goes first, the owner's own thread second,
// proactive reminders last — they have a whole window to be delivered in.
const PRIORITY_ORDER: Record<SendPriority, number> = { reply: 0, owner: 1, reminder: 2 }

// One message every 1.5–2.5s. Randomised because a fixed cadence is itself the
// pattern we are trying not to produce.
export const MIN_GAP_MS = 1_500
export const MAX_GAP_MS = 2_500
export const MAX_PER_MINUTE = 25
export const MAX_PER_HOUR = 200
// Past this depth the number is already talking more than a person would, so
// the queue stretches its gaps instead of trying to keep up with the backlog.
export const BACKPRESSURE_DEPTH = 30
export const BACKPRESSURE_FACTOR = 1.5
// Nothing legitimate in V1 queues this much. Worth an error line: it is the
// closest thing we have to an early warning that a number is over-sending.
export const ALERT_DEPTH = 50

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

interface Job {
  priority: SendPriority
  run: () => Promise<void>
  resolve: () => void
  reject: (reason: unknown) => void
  /** Monotonic arrival order. Date.now() ties within a millisecond. */
  seq: number
}

interface Lane {
  jobs: Job[]
  draining: boolean
  /** Send timestamps, oldest first. Both rate limits are read from this. */
  sentAt: number[]
}

const lanes = new Map<string, Lane>()
let sequence = 0
let stopped = false

function laneFor(businessId: string): Lane {
  const existing = lanes.get(businessId)
  if (existing) return existing
  const lane: Lane = { jobs: [], draining: false, sentAt: [] }
  lanes.set(businessId, lane)
  return lane
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function randomGapMs(depth: number): number {
  const base = MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS)
  return Math.round(depth > BACKPRESSURE_DEPTH ? base * BACKPRESSURE_FACTOR : base)
}

/**
 * How long the lane must wait before another send is allowed by one sliding
 * window: zero while under the cap, otherwise until the oldest send that has to
 * age out actually does.
 */
function windowWaitMs(sentAt: number[], now: number, windowMs: number, max: number): number {
  const inWindow = sentAt.filter((t) => now - t < windowMs)
  if (inWindow.length < max) return 0
  const mustExpire = inWindow[inWindow.length - max]
  if (mustExpire === undefined) return 0
  return Math.max(0, mustExpire + windowMs - now)
}

/** The gap since the last send, plus whatever the rate limits demand on top. */
function waitBeforeNextSendMs(lane: Lane, now: number): number {
  const last = lane.sentAt[lane.sentAt.length - 1]
  const gapWait = last === undefined ? 0 : Math.max(0, last + randomGapMs(lane.jobs.length) - now)
  return Math.max(
    gapWait,
    windowWaitMs(lane.sentAt, now, MINUTE_MS, MAX_PER_MINUTE),
    windowWaitMs(lane.sentAt, now, HOUR_MS, MAX_PER_HOUR),
  )
}

function pruneSentAt(lane: Lane, now: number): void {
  while (lane.sentAt.length > 0 && now - (lane.sentAt[0] ?? 0) >= HOUR_MS) lane.sentAt.shift()
}

async function drain(businessId: string, lane: Lane): Promise<void> {
  if (lane.draining) return
  lane.draining = true
  try {
    while (lane.jobs.length > 0 && !stopped) {
      const wait = waitBeforeNextSendMs(lane, Date.now())
      if (wait > 0) await sleep(wait)
      if (stopped) return

      const job = lane.jobs.shift()
      if (!job) break

      const startedAt = Date.now()
      // Recorded before the attempt: a send that fails still reached WhatsApp
      // and still counts against the number.
      lane.sentAt.push(startedAt)
      pruneSentAt(lane, startedAt)

      try {
        await job.run()
        // Observed here because this is the one place every outbound message
        // passes through: no call site can add a send that skips measurement.
        recordSendResult(businessId, true)
        job.resolve()
      } catch (err) {
        recordSendResult(businessId, false, err)
        // Rejected, not swallowed: every caller already handles a failed send,
        // and several of them have to tell the owner it did not go out.
        job.reject(err)
      }
    }
  } finally {
    lane.draining = false
    if (lane.jobs.length === 0 && lane.sentAt.length === 0) lanes.delete(businessId)
  }
}

/**
 * Queues one outbound message for a business number and resolves once it has
 * actually been sent.
 *
 * `run` must contain the WHOLE send, including any presence updates: a
 * "composing" fired outside the queue would leave a typing indicator up for a
 * message still seconds away in the backlog.
 */
export function enqueueSend(
  businessId: string,
  priority: SendPriority,
  run: () => Promise<void>,
): Promise<void> {
  if (stopped) {
    return Promise.reject(new Error('send queue stopped; message not sent'))
  }

  const lane = laneFor(businessId)
  return new Promise<void>((resolve, reject) => {
    lane.jobs.push({ priority, run, resolve, reject, seq: sequence++ })
    // Stable within a priority: a burst of replies keeps arrival order.
    lane.jobs.sort(
      (a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.seq - b.seq,
    )

    if (lane.jobs.length >= ALERT_DEPTH) {
      logger.error(
        { businessId, depth: lane.jobs.length },
        'send queue backed up — this number may be over-sending',
      )
    }

    void drain(businessId, lane)
  })
}

/**
 * Refuses new work and drops everything still queued, returning how many jobs
 * were discarded.
 *
 * Called from the shutdown path. With roughly 8s before SIGKILL there is no
 * honest way to drain a backlog, and a message cut off mid-flight is worse than
 * one that never started — every caller already handles a rejected send.
 */
export function stopQueue(): number {
  stopped = true
  let dropped = 0
  for (const [businessId, lane] of lanes) {
    for (const job of lane.jobs) {
      dropped++
      job.reject(new Error(`send queue stopped before this ${job.priority} message was sent`))
    }
    lane.jobs.length = 0
    lanes.delete(businessId)
  }
  return dropped
}
