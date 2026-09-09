import type { WhatsappClient } from './baileys.client.js'

// Este registry vive en memoria del proceso. En producción multi-instance
// (Día 11 si escalamos), reemplazar por algo centralizado (eg. cada instancia
// publica su businessId en Redis y los mensajes se enrutan por pub/sub).
// Para V1 con 1 instancia en Railway, alcanza.
const clients = new Map<string, WhatsappClient>()

export type ConnectionStatus = 'connecting' | 'qr_pending' | 'connected' | 'logged_out'

interface ConnectionState {
  status: ConnectionStatus
  qr: string | null
  pairingCode: string | null
  /** When the current status was entered. Drives "this number has been down for N". */
  statusSince: number
  /** Last sign of life from WhatsApp for this number. Null until the first one. */
  lastEventAt: number | null
}

/**
 * What the health monitor and /health are allowed to see.
 *
 * Deliberately WITHOUT qr and pairingCode: those are session credentials, and
 * /health is unauthenticated. A snapshot type keeps that impossible to get wrong
 * by accident rather than depending on every caller remembering to strip them.
 */
export interface ConnectionSnapshot {
  businessId: string
  status: ConnectionStatus
  statusSince: number
  lastEventAt: number | null
}

const connectionStates = new Map<string, ConnectionState>()

// Rate-limit state deliberately does NOT live here. It is keyed by phone number
// and persisted in `whatsapp_session_guard` (see sessionGuard.service.ts),
// because WhatsApp throttles the number rather than our process — an in-memory
// cooldown resets on every Railway deploy, which is exactly when the risk of
// re-hammering a punished number is highest.

function blankState(status: ConnectionStatus): ConnectionState {
  return { status, qr: null, pairingCode: null, statusSince: Date.now(), lastEventAt: null }
}

export function registerClient(businessId: string, client: WhatsappClient): void {
  clients.set(businessId, client)
  connectionStates.set(businessId, blankState('connecting'))
}

export function setConnectionStatus(businessId: string, status: ConnectionStatus): void {
  const prev = connectionStates.get(businessId) ?? blankState(status)
  connectionStates.set(businessId, {
    ...prev,
    status,
    // Only on a real transition: re-setting the same status must not keep
    // resetting the clock, or a number stuck disconnected would always look
    // like it just went down.
    statusSince: prev.status === status ? prev.statusSince : Date.now(),
    qr: status === 'connected' ? null : prev.qr,
    pairingCode: status === 'connected' ? null : prev.pairingCode,
  })
}

export function storeQR(businessId: string, qr: string): void {
  const prev = connectionStates.get(businessId) ?? blankState('qr_pending')
  connectionStates.set(businessId, {
    ...prev,
    status: 'qr_pending',
    statusSince: prev.status === 'qr_pending' ? prev.statusSince : Date.now(),
    qr,
  })
}

export function storePairingCode(businessId: string, code: string): void {
  const prev = connectionStates.get(businessId) ?? blankState('connecting')
  connectionStates.set(businessId, { ...prev, pairingCode: code })
}

/**
 * Records that WhatsApp gave us a sign of life for this number.
 *
 * Mutated in place rather than replaced: this runs on every inbound message and
 * the value is read-only bookkeeping.
 */
export function touchActivity(businessId: string): void {
  const state = connectionStates.get(businessId)
  if (!state) return
  state.lastEventAt = Date.now()
}

/** Credential-free view of every number's connection state. */
export function getConnectionSnapshots(): ConnectionSnapshot[] {
  return [...connectionStates.entries()].map(([businessId, state]) => ({
    businessId,
    status: state.status,
    statusSince: state.statusSince,
    lastEventAt: state.lastEventAt,
  }))
}

export function getConnectionState(businessId: string): ConnectionState | null {
  return connectionStates.get(businessId) ?? null
}

export function getClient(businessId: string): WhatsappClient | null {
  return clients.get(businessId) ?? null
}

/**
 * Every client currently registered, as [businessId, client] pairs.
 *
 * Exists for the shutdown drain: killing the process without closing these
 * leaves the sessions registered on WhatsApp's side, and the container that
 * replaces us links with the same credentials while the old device is still
 * listed.
 */
export function getAllClients(): ReadonlyArray<[string, WhatsappClient]> {
  return [...clients.entries()]
}

export function unregisterClient(businessId: string): void {
  clients.delete(businessId)
  connectionStates.delete(businessId)
}

// Test-only helper: drops every registered client so isolated tests don't
// leak fake clients between cases. Not used from production code.
export function _resetRegistryForTests(): void {
  clients.clear()
  connectionStates.clear()
}
