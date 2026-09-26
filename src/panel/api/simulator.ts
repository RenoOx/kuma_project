import { apiGet, apiSend, type PanelSession } from './client.js'
import type { SimulatorStatus, SimulatorTurn } from './types.js'

export function getSimulatorStatus(session: PanelSession): Promise<SimulatorStatus> {
  return apiGet<SimulatorStatus>(session, '/simulator')
}

/** Un cliente de prueba nuevo: la conversación arranca desde el saludo. */
export function createSimulatorSession(session: PanelSession): Promise<{ sessionId: string }> {
  return apiSend<{ sessionId: string }>(session, 'POST', '/simulator/sessions')
}

export function sendSimulatorMessage(
  session: PanelSession,
  sessionId: string,
  text: string,
): Promise<SimulatorTurn> {
  return apiSend<SimulatorTurn>(session, 'POST', '/simulator/messages', { sessionId, text })
}
