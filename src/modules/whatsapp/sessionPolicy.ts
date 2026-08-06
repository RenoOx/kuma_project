import { DisconnectReason } from '@whiskeysockets/baileys'

// Pure policy helpers for WhatsApp session lifecycle. No DB, no sockets — the
// decisions here are what stand between us and a banned number, so they live
// apart from I/O and stay unit-testable.

export type DisconnectKind = 'halt' | 'restart_required' | 'transient'

// Reconnect budget for transient drops. Exponential, capped, and finite: after
// MAX_RECONNECT_ATTEMPTS we stop entirely rather than hammer WhatsApp forever.
// WhatsApp extends a rate-limit indefinitely if the client keeps retrying
// through it, so "give up and wait for a human" is the safe terminal state.
export const RECONNECT_BASE_DELAY_MS = 5_000
export const RECONNECT_MAX_DELAY_MS = 160_000
export const MAX_RECONNECT_ATTEMPTS = 6

// While a QR is on screen waiting to be scanned, WhatsApp closes the socket
// every time the code expires. Those closes are the normal rhythm of pairing,
// not failures, so they get their own generous budget and a short fixed delay —
// a person needs time to find their phone, open WhatsApp and scan. Sharing the
// transient budget meant six expired QRs looked identical to six crashes.
export const MAX_QR_PAIRING_CYCLES = 20
export const QR_PAIRING_RETRY_DELAY_MS = 2_000

// Delay right after a 515 restartRequired. This is a normal step of the pairing
// handshake (WhatsApp asks for a reconnect once linking succeeds), not a
// failure, so it gets a short fixed delay and no backoff.
export const RESTART_REQUIRED_DELAY_MS = 1_000

/**
 * Classifies a disconnect status code into what we should do about it.
 *
 * - `halt`: WhatsApp rejected us in a way retrying cannot fix, and retrying
 *   actively makes it worse (revoked creds, ban, session stolen). Stop dead.
 * - `restart_required`: expected mid-pairing handshake step. Reconnect at once
 *   and do NOT count it as a failure.
 * - `transient`: network blip or server hiccup. Reconnect with backoff.
 */
export function classifyDisconnect(statusCode: number | undefined): DisconnectKind {
  switch (statusCode) {
    // Creds revoked by the user, WhatsApp banned/forbade the number, another
    // session replaced ours, or the multi-device state no longer matches.
    // Every one of these is permanent until a human intervenes.
    case DisconnectReason.loggedOut:
    case DisconnectReason.forbidden:
    case DisconnectReason.connectionReplaced:
    case DisconnectReason.multideviceMismatch:
      return 'halt'
    case DisconnectReason.restartRequired:
      return 'restart_required'
    default:
      return 'transient'
  }
}

/** Human-readable name for a disconnect status code, for logs and halt reasons. */
export function disconnectReasonName(statusCode: number | undefined): string {
  if (statusCode === undefined) return 'unknown'
  return DisconnectReason[statusCode] ?? String(statusCode)
}

/**
 * Exponential backoff for reconnect attempt N (1-based), capped.
 * 1→5s, 2→10s, 3→20s, 4→40s, 5→80s, 6→160s.
 */
export function reconnectDelayMs(attempt: number): number {
  if (attempt < 1) return RECONNECT_BASE_DELAY_MS
  const raw = RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1)
  return Math.min(raw, RECONNECT_MAX_DELAY_MS)
}

/** True once a transient reconnect loop has burned its whole budget. */
export function hasExhaustedReconnects(attempt: number): boolean {
  return attempt > MAX_RECONNECT_ATTEMPTS
}

// ── Circuit breaker ──────────────────────────────────────────────────────────

// Every pairing-code request and every socket restart is a request WhatsApp
// counts against the number. Five in an hour is already near the threshold
// where WhatsApp starts refusing links, so we stop there and sit out 6h.
export const ATTEMPT_WINDOW_MS = 60 * 60 * 1_000
export const MAX_ATTEMPTS_PER_WINDOW = 5
export const CIRCUIT_BREAKER_BLOCK_MS = 6 * 60 * 60 * 1_000

// Per-action cooldowns, enforced on top of the window budget.
export const PAIRING_CODE_COOLDOWN_MS = 90_000
export const RESTART_COOLDOWN_MS = 60_000

export interface AttemptWindow {
  attemptCount: number
  attemptWindowStartedAt: Date
}

/**
 * Folds a new attempt into the rolling window, starting a fresh window when the
 * previous one has aged out.
 */
export function nextAttemptWindow(
  current: { attemptCount: number; attemptWindowStartedAt: Date | null } | null,
  now: Date,
): AttemptWindow {
  const startedAt = current?.attemptWindowStartedAt
  const windowExpired = !startedAt || now.getTime() - startedAt.getTime() >= ATTEMPT_WINDOW_MS
  if (windowExpired) {
    return { attemptCount: 1, attemptWindowStartedAt: now }
  }
  return { attemptCount: (current?.attemptCount ?? 0) + 1, attemptWindowStartedAt: startedAt }
}

/** True when the folded window has spent its budget and the breaker must trip. */
export function shouldTripBreaker(window: AttemptWindow): boolean {
  return window.attemptCount >= MAX_ATTEMPTS_PER_WINDOW
}
