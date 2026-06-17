import type { WhatsappClient } from './baileys.client.js'

// Este registry vive en memoria del proceso. En producción multi-instance
// (Día 11 si escalamos), reemplazar por algo centralizado (eg. cada instancia
// publica su businessId en Redis y los mensajes se enrutan por pub/sub).
// Para V1 con 1 instancia en Railway, alcanza.
const clients = new Map<string, WhatsappClient>()

export function registerClient(businessId: string, client: WhatsappClient): void {
  clients.set(businessId, client)
}

export function getClient(businessId: string): WhatsappClient | null {
  return clients.get(businessId) ?? null
}

export function unregisterClient(businessId: string): void {
  clients.delete(businessId)
}

// Test-only helper: drops every registered client so isolated tests don't
// leak fake clients between cases. Not used from production code.
export function _resetRegistryForTests(): void {
  clients.clear()
}
