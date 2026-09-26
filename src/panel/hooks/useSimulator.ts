import { useQuery } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { PanelApiError } from '../api/client.js'
import {
  createSimulatorSession,
  getSimulatorStatus,
  sendSimulatorMessage,
} from '../api/simulator.js'
import type { SimulatorStatus, SimulatorTurn } from '../api/types.js'
import { useSession } from '../lib/session.js'

/** Si el servidor tiene el simulador prendido. Decide si el menú muestra la página. */
export function useSimulatorStatus() {
  const session = useSession()
  return useQuery<SimulatorStatus>({
    queryKey: ['simulator', session.businessId],
    queryFn: () => getSimulatorStatus(session),
    // Depende de una variable de entorno del servidor: no cambia sin reiniciarlo.
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/** Un mensaje tuyo y, cuando llega, el turno de Emma que lo respondió. */
export interface SimulatorEntry {
  id: number
  text: string
  turn: SimulatorTurn | null
  error: string | null
}

export interface SimulatorChat {
  entries: SimulatorEntry[]
  sending: boolean
  send: (text: string) => Promise<void>
  /** Descarta la conversación: el próximo mensaje es de un cliente de prueba nuevo. */
  reset: () => void
}

// Estado local de la página y no de React Query: es una conversación que existe
// mientras la pantalla está abierta, no un dato del servidor que haya que
// sincronizar. Recargar es empezar de cero, igual que "Nueva conversación".
export function useSimulatorChat(): SimulatorChat {
  const session = useSession()
  const [entries, setEntries] = useState<SimulatorEntry[]>([])
  const [sending, setSending] = useState(false)
  const sessionId = useRef<string | null>(null)
  const nextId = useRef(1)

  const patch = (id: number, change: Partial<SimulatorEntry>): void => {
    setEntries((current) => current.map((e) => (e.id === id ? { ...e, ...change } : e)))
  }

  const send = async (text: string): Promise<void> => {
    const id = nextId.current++
    setEntries((current) => [...current, { id, text, turn: null, error: null }])
    setSending(true)
    try {
      if (!sessionId.current) {
        sessionId.current = (await createSimulatorSession(session)).sessionId
      }
      const turn = await sendSimulatorMessage(session, sessionId.current, text)
      patch(id, { turn })
    } catch (cause) {
      const message =
        cause instanceof PanelApiError && cause.userMessage
          ? cause.userMessage
          : 'No se pudo obtener la respuesta de Emma.'
      patch(id, { error: message })
    } finally {
      setSending(false)
    }
  }

  const reset = (): void => {
    sessionId.current = null
    setEntries([])
  }

  return { entries, sending, send, reset }
}
