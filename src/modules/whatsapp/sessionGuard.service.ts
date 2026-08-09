import { logger } from '@/config/logger.js'
import type { WhatsappSessionGuard } from '@/db/schema/index.js'
import { SessionGuardError } from '@/shared/errors.js'
import * as guardRepo from './sessionGuard.repo.js'
import {
  CIRCUIT_BREAKER_BLOCK_MS,
  PAIRING_CODE_COOLDOWN_MS,
  RESTART_COOLDOWN_MS,
  nextAttemptWindow,
  shouldTripBreaker,
} from './sessionPolicy.js'

const log = logger.child({ component: 'whatsapp-session-guard' })

export interface GuardStatus {
  blocked: boolean
  /** Milliseconds until the number is usable again. 0 when not blocked. */
  retryAfterMs: number
  blockedUntil: Date | null
  haltReason: string | null
  attemptCount: number
}

function remainingMs(until: Date | null | undefined, now: Date): number {
  if (!until) return 0
  return Math.max(0, until.getTime() - now.getTime())
}

/**
 * Reads the guard row, treating an unreadable guard as "no data" instead of an
 * error.
 *
 * The distinction that matters: "the guard says blocked" must stop the caller,
 * but "the guard cannot be read" must not. They are not the same evidence. A
 * missing table or a DB blip previously propagated out of assertCanRestart and
 * turned the admin panel's Connect button into a 500 — leaving no way at all to
 * link WhatsApp, which is far worse than losing one attempt counter.
 */
async function readGuard(whatsappNumber: string): Promise<WhatsappSessionGuard | null> {
  try {
    return await guardRepo.findByNumber(whatsappNumber)
  } catch (err) {
    log.error(
      { err, whatsappNumber },
      'session guard unreadable — proceeding without ban protection for this action',
    )
    return null
  }
}

function toStatus(guard: WhatsappSessionGuard | null, now: Date): GuardStatus {
  const retryAfterMs = remainingMs(guard?.blockedUntil, now)
  return {
    blocked: retryAfterMs > 0,
    retryAfterMs,
    blockedUntil: guard?.blockedUntil ?? null,
    haltReason: guard?.haltReason ?? null,
    attemptCount: guard?.attemptCount ?? 0,
  }
}

/** Read-only view of a number's guard state. Safe to call from render paths. */
export async function getStatus(whatsappNumber: string): Promise<GuardStatus> {
  const guard = await readGuard(whatsappNumber)
  return toStatus(guard, new Date())
}

function assertNotBlocked(guard: WhatsappSessionGuard | null, whatsappNumber: string, now: Date) {
  const retryAfterMs = remainingMs(guard?.blockedUntil, now)
  if (retryAfterMs <= 0) return

  const haltReason = guard?.haltReason ?? null
  throw new SessionGuardError({
    whatsappNumber,
    reason: haltReason ? 'halted' : 'blocked',
    retryAfterMs,
    userMessage: haltReason
      ? `WhatsApp cerró la sesión de este número (${haltReason}). Reintentar ahora puede banearlo.`
      : 'Se alcanzó el límite de intentos de vinculación. Esperá antes de reintentar.',
    logContext: { haltReason, attemptCount: guard?.attemptCount ?? 0 },
  })
}

function assertCooldownElapsed(
  last: Date | null | undefined,
  cooldownMs: number,
  whatsappNumber: string,
  now: Date,
) {
  if (!last) return
  const elapsed = now.getTime() - last.getTime()
  const retryAfterMs = Math.max(0, cooldownMs - elapsed)
  if (retryAfterMs <= 0) return
  throw new SessionGuardError({ whatsappNumber, reason: 'cooldown', retryAfterMs })
}

/** Throws unless a fresh socket may be booted for this number right now. */
export async function assertCanRestart(whatsappNumber: string): Promise<void> {
  const now = new Date()
  const guard = await readGuard(whatsappNumber)
  assertNotBlocked(guard, whatsappNumber, now)
  assertCooldownElapsed(guard?.lastRestartAt, RESTART_COOLDOWN_MS, whatsappNumber, now)
}

/** Throws unless a pairing code may be requested from WhatsApp right now. */
export async function assertCanRequestPairingCode(whatsappNumber: string): Promise<void> {
  const now = new Date()
  const guard = await readGuard(whatsappNumber)
  assertNotBlocked(guard, whatsappNumber, now)
  assertCooldownElapsed(guard?.lastPairingCodeAt, PAIRING_CODE_COOLDOWN_MS, whatsappNumber, now)
}

/**
 * Persists guard state without letting a storage failure abort the caller's
 * action. Bookkeeping is worth less than the operation it accompanies: losing a
 * counter tick degrades protection, while throwing here would block the
 * operator from connecting WhatsApp at all.
 */
async function safeUpsert(
  data: Parameters<typeof guardRepo.upsert>[0],
): Promise<WhatsappSessionGuard | null> {
  try {
    return await guardRepo.upsert(data)
  } catch (err) {
    log.error(
      { err, whatsappNumber: data.whatsappNumber },
      'failed to persist session guard state — action continues unprotected',
    )
    return null
  }
}

async function recordAttempt(
  whatsappNumber: string,
  businessId: string | null,
  field: 'lastRestartAt' | 'lastPairingCodeAt',
): Promise<GuardStatus> {
  const now = new Date()
  const guard = await readGuard(whatsappNumber)
  const window = nextAttemptWindow(guard, now)
  const tripped = shouldTripBreaker(window)
  const blockedUntil = tripped ? new Date(now.getTime() + CIRCUIT_BREAKER_BLOCK_MS) : (guard?.blockedUntil ?? null)

  const saved = await safeUpsert({
    whatsappNumber,
    businessId,
    [field]: now,
    attemptCount: window.attemptCount,
    attemptWindowStartedAt: window.attemptWindowStartedAt,
    blockedUntil,
    haltReason: guard?.haltReason ?? null,
  })

  if (tripped) {
    log.error(
      { whatsappNumber, businessId, attemptCount: window.attemptCount, blockedUntil },
      'whatsapp linking circuit breaker TRIPPED — number is now blocked to avoid a ban',
    )
  }
  return toStatus(saved, now)
}

export async function recordRestart(
  whatsappNumber: string,
  businessId: string | null,
): Promise<GuardStatus> {
  return recordAttempt(whatsappNumber, businessId, 'lastRestartAt')
}

export async function recordPairingCode(
  whatsappNumber: string,
  businessId: string | null,
): Promise<GuardStatus> {
  return recordAttempt(whatsappNumber, businessId, 'lastPairingCodeAt')
}

/**
 * Records that a session stopped for a reason that carries no ban risk, without
 * imposing any cool-off.
 *
 * Giving up on reconnects is not abuse. The clearest case: while a QR is on
 * screen waiting to be scanned, WhatsApp closes the socket with `timedOut` every
 * time the code expires. Counting those as failures meant six unscanned QRs
 * locked the number out for six hours — punishing the operator for taking too
 * long to pick up their phone. Ban protection belongs on the actions that
 * actually reach WhatsApp (pairing codes and restarts), which are counted
 * separately.
 */
export async function recordSessionStopped(
  whatsappNumber: string,
  businessId: string | null,
  reason: string,
): Promise<void> {
  await safeUpsert({ whatsappNumber, businessId, blockedUntil: null, haltReason: reason })
  log.warn(
    { whatsappNumber, businessId, reason },
    'whatsapp session stopped — reconnect halted, number NOT blocked (no ban risk in this reason)',
  )
}

/**
 * WhatsApp handed us a fatal disconnect, or a reconnect loop burned its budget.
 * Always stops the reconnect loop; imposes the cool-off block ONLY when there is
 * evidence we were hammering.
 *
 * `loggedOut` (401) is the same status code whether WhatsApp revoked our
 * credentials for abuse or the owner simply tapped "log out" on their phone.
 * The two are indistinguishable at the protocol level but opposite in risk, so
 * the attempt counter breaks the tie.
 *
 * The threshold is "more than one prior attempt", not "any". Linking legitimately
 * costs one attempt — the operator presses Connect once — so treating a single
 * attempt as evidence of hammering blocked people for six hours on their first
 * honest try. One failure is a failure; two in the same window is a pattern.
 * The 5-attempts-per-hour circuit breaker still backstops this independently.
 */
export async function recordHalt(
  whatsappNumber: string,
  businessId: string | null,
  reason: string,
): Promise<void> {
  const now = new Date()
  const guard = await readGuard(whatsappNumber)
  const window = nextAttemptWindow(guard, now)
  // nextAttemptWindow folds in a hypothetical new attempt, so the count of
  // attempts that actually happened is one less.
  const priorAttempts = window.attemptCount - 1
  const wasHammering = priorAttempts > 1

  const blockedUntil = wasHammering ? new Date(now.getTime() + CIRCUIT_BREAKER_BLOCK_MS) : null
  await safeUpsert({ whatsappNumber, businessId, blockedUntil, haltReason: reason })

  if (wasHammering) {
    log.error(
      { whatsappNumber, businessId, reason, priorAttempts, blockedUntil },
      'whatsapp session HALTED after repeated attempts — number blocked until cool-off or explicit operator override',
    )
    return
  }
  log.warn(
    { whatsappNumber, businessId, reason },
    'whatsapp session ended with no prior linking attempts (likely unlinked from the phone) — reconnect stopped, but the number is NOT blocked',
  )
}

/** A successful link clears the slate: the number proved it is healthy. */
export async function recordConnected(
  whatsappNumber: string,
  businessId: string | null,
): Promise<void> {
  await safeUpsert({
    whatsappNumber,
    businessId,
    attemptCount: 0,
    attemptWindowStartedAt: null,
    blockedUntil: null,
    haltReason: null,
  })
}

/**
 * Operator escape hatch. Deliberately loud: forcing past a block is exactly how
 * the previous production number got burned, so every use leaves a trail.
 */
export async function forceUnblock(whatsappNumber: string, businessId: string | null): Promise<void> {
  const previous = await readGuard(whatsappNumber)
  await safeUpsert({
    whatsappNumber,
    businessId,
    attemptCount: 0,
    attemptWindowStartedAt: null,
    blockedUntil: null,
    haltReason: null,
    lastPairingCodeAt: null,
    lastRestartAt: null,
  })
  log.warn(
    {
      whatsappNumber,
      businessId,
      clearedHaltReason: previous?.haltReason ?? null,
      clearedBlockedUntil: previous?.blockedUntil ?? null,
      clearedAttemptCount: previous?.attemptCount ?? 0,
    },
    'whatsapp session guard FORCE-UNBLOCKED by operator — bypassing ban protection',
  )
}
