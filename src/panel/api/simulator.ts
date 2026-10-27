import { apiGet, apiSend, type PanelSession } from './client.js'
import type { SimulatorStatus, SimulatorTurn } from './types.js'

export function getSimulatorStatus(session: PanelSession): Promise<SimulatorStatus> {
  return apiGet<SimulatorStatus>(session, '/simulator')
}

/** Un cliente de prueba nuevo: la conversación arranca desde el saludo. */
export function createSimulatorSession(session: PanelSession): Promise<{ sessionId: string }> {
  return apiSend<{ sessionId: string }>(session, 'POST', '/simulator/sessions')
}

/** `version`: el id de una versión en prueba, o null para la de siempre (la de WhatsApp). */
export function sendSimulatorMessage(
  session: PanelSession,
  sessionId: string,
  version: string | null,
  text: string,
): Promise<SimulatorTurn> {
  return apiSend<SimulatorTurn>(session, 'POST', '/simulator/messages', {
    sessionId,
    version,
    text,
  })
}

/** Fotos de prueba mandadas juntas. Los bytes no viajan: solo cuántas y el texto. */
export function sendSimulatorImages(
  session: PanelSession,
  sessionId: string,
  version: string | null,
  count: number,
  caption?: string,
): Promise<SimulatorTurn> {
  return apiSend<SimulatorTurn>(session, 'POST', '/simulator/images', {
    sessionId,
    version,
    count,
    ...(caption ? { caption } : {}),
  })
}

/** "Reactivar Emma" en la conversación de prueba, como el interruptor del Inbox. */
export function resumeSimulatorEmma(session: PanelSession, sessionId: string): Promise<void> {
  return apiSend<void>(session, 'POST', '/simulator/resume', { sessionId })
}
