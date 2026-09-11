import { apiGet, type PanelSession } from './client.js'
import type { PanelHealth, PanelMe } from './types.js'

/** Business identity and niche. Drives the header and every "Pacientes"/"Clientes" label. */
export function getMe(session: PanelSession): Promise<PanelMe> {
  return apiGet<PanelMe>(session, '/me')
}

export function getHealth(session: PanelSession): Promise<PanelHealth> {
  return apiGet<PanelHealth>(session, '/health')
}
