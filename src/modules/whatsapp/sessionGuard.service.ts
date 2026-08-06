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
  const guard = await guardRepo.findByNumber(whatsappNumber)
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
  const guard = await guardRepo.findByNumber(whatsappNumber)
  assertNotBlocked(guard, whatsappNumber, now)
  assertCooldownElapsed(guard?.lastRestartAt, RESTART_COOLDOWN_MS, whatsappNumber, now)
}

/** Throws unless a pairing code may be requested from WhatsApp right now. */
export async function assertCanRequestPairingCode(whatsappNumber: string): Promise<void> {
  const now = new Date()
  const guard = await guardRepo.findByNumber(whatsappNumber)
  assertNotBlocked(guard, whatsappNumber, now)
  assertCooldownElapsed(guard?.lastPairingCodeAt, PAIRING_CODE_COOLDOWN_MS, whatsappNumber, now)
}

async function recordAttempt(
  whatsappNumber: string,
  businessId: string | null,
  field: 'lastRestartAt' | 'lastPairingCodeAt',
): Promise<GuardStatus> {
  const now = new Date()
  const guard = await guardRepo.findByNumber(whatsappNumber)
  const window = nextAttemptWindow(guard, now)
  const tripped = shouldTripBreaker(window)
  const blockedUntil = tripped ? new Date(now.getTime() + CIRCUIT_BREAKER_BLOCK_MS) : (guard?.blockedUntil ?? null)

  const saved = await guardRepo.upsert({
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
 * WhatsApp handed us a fatal disconnect, or a reconnect loop burned its budget.
 * Blocks the number so neither an operator click nor a Railway redeploy can
 * re-hammer it before the cool-off passes.
 */
export async function recordHalt(
  whatsappNumber: string,
  businessId: string | null,
  reason: string,
): Promise<void> {
  const now = new Date()
  const blockedUntil = new Date(now.getTime() + CIRCUIT_BREAKER_BLOCK_MS)
  await guardRepo.upsert({ whatsappNumber, businessId, blockedUntil, haltReason: reason })
  log.error(
    { whatsappNumber, businessId, reason, blockedUntil },
    'whatsapp session HALTED — number blocked until cool-off or explicit operator override',
  )
}

/** A successful link clears the slate: the number proved it is healthy. */
export async function recordConnected(
  whatsappNumber: string,
  businessId: string | null,
): Promise<void> {
  await guardRepo.upsert({
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
  const previous = await guardRepo.findByNumber(whatsappNumber)
  await guardRepo.upsert({
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
