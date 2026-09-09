import { logger } from '@/config/logger.js'
import * as clientRegistry from './clientRegistry.js'

// Presence lifecycle for a business number.
//
// Both extremes are detectable. An account that transmits around the clock but
// is never online is anomalous; one that is online 24/7 is anomalous too, and
// leaks its activity to every contact. What a receptionist actually looks like
// is presence in bursts: online while working through messages, gone a while
// after the last one.
//
// `markOnlineOnConnect` stays false in the socket config on purpose. This module
// is the manual replacement: nothing is announced at the instant of connecting,
// which is itself a tell — a real client takes a moment to come up.

const log = logger.child({ component: 'whatsapp.presence' })

// A device does not report itself online in the same tick it finishes linking.
const INITIAL_PRESENCE_MIN_MS = 2_000
const INITIAL_PRESENCE_MAX_MS = 5_000
// Long enough that a normal back-and-forth never flickers offline mid-thread,
// short enough that a quiet afternoon reads as nobody at the desk.
const IDLE_TIMEOUT_MS = 10 * 60 * 1000

interface PresenceState {
  available: boolean
  idleTimer: NodeJS.Timeout | null
  initialTimer: NodeJS.Timeout | null
}

const states = new Map<string, PresenceState>()

function stateFor(businessId: string): PresenceState {
  const existing = states.get(businessId)
  if (existing) return existing
  const state: PresenceState = { available: false, idleTimer: null, initialTimer: null }
  states.set(businessId, state)
  return state
}

/**
 * Pushes a presence update, swallowing failures.
 *
 * Cosmetic by contract, exactly like the composing indicator in outbound.ts:
 * presence is a signal about us, never a message someone is waiting on, and it
 * must never take down the path that called it.
 */
async function push(businessId: string, presence: 'available' | 'unavailable'): Promise<void> {
  const sock = clientRegistry.getClient(businessId)?.sock
  if (!sock) return
  try {
    await sock.sendPresenceUpdate(presence)
    log.info({ businessId, presence }, 'presence updated')
  } catch (err) {
    log.warn({ err, businessId, presence }, 'presence update failed')
  }
}

function scheduleIdle(businessId: string, state: PresenceState): void {
  if (state.idleTimer) clearTimeout(state.idleTimer)
  state.idleTimer = setTimeout(() => {
    state.idleTimer = null
    state.available = false
    void push(businessId, 'unavailable')
  }, IDLE_TIMEOUT_MS)
  state.idleTimer.unref()
}

/**
 * Comes online a few seconds after linking, then starts the idle countdown.
 *
 * Called from the connect handler. The delay is the point: announcing presence
 * in the same instant the socket opens is machine timing.
 */
export function scheduleInitialPresence(businessId: string): void {
  const state = stateFor(businessId)
  if (state.initialTimer) clearTimeout(state.initialTimer)

  const delay =
    INITIAL_PRESENCE_MIN_MS + Math.random() * (INITIAL_PRESENCE_MAX_MS - INITIAL_PRESENCE_MIN_MS)
  state.initialTimer = setTimeout(() => {
    state.initialTimer = null
    state.available = true
    void push(businessId, 'available')
    scheduleIdle(businessId, state)
  }, delay)
  state.initialTimer.unref()
}

/**
 * Records that this number just did something real, so it reads as online and
 * the idle countdown restarts.
 *
 * The 'available' push only goes out on the transition, not on every message:
 * re-announcing the same presence per inbound message is its own pattern.
 */
export function markActive(businessId: string): void {
  const state = stateFor(businessId)
  if (!state.available) {
    state.available = true
    void push(businessId, 'available')
  }
  scheduleIdle(businessId, state)
}

/**
 * Drops every timer for a business. Called before a socket is replaced and on
 * shutdown, so a pending update never fires against a dead or reassigned socket.
 */
export function stopPresence(businessId: string): void {
  const state = states.get(businessId)
  if (!state) return
  if (state.idleTimer) clearTimeout(state.idleTimer)
  if (state.initialTimer) clearTimeout(state.initialTimer)
  states.delete(businessId)
}
