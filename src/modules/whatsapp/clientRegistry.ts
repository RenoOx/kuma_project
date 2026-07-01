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
}

const connectionStates = new Map<string, ConnectionState>()

export function registerClient(businessId: string, client: WhatsappClient): void {
  clients.set(businessId, client)
  connectionStates.set(businessId, { status: 'connecting', qr: null, pairingCode: null })
}

export function setConnectionStatus(businessId: string, status: ConnectionStatus): void {
  const prev = connectionStates.get(businessId) ?? { status, qr: null, pairingCode: null }
  connectionStates.set(businessId, {
    ...prev,
    status,
    qr: status === 'connected' ? null : prev.qr,
    pairingCode: status === 'connected' ? null : prev.pairingCode,
  })
}

export function storeQR(businessId: string, qr: string): void {
  const prev = connectionStates.get(businessId) ?? { status: 'qr_pending', qr, pairingCode: null }
  connectionStates.set(businessId, { ...prev, status: 'qr_pending', qr })
}

export function storePairingCode(businessId: string, code: string): void {
  const prev = connectionStates.get(businessId) ?? { status: 'connecting', qr: null, pairingCode: code }
  connectionStates.set(businessId, { ...prev, pairingCode: code })
}

export function getConnectionState(businessId: string): ConnectionState | null {
  return connectionStates.get(businessId) ?? null
}

export function getClient(businessId: string): WhatsappClient | null {
  return clients.get(businessId) ?? null
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
