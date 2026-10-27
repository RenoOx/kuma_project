import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { PanelApiError } from '../api/client.js'
import {
  createSimulatorSession,
  getSimulatorStatus,
  resumeSimulatorEmma,
  sendSimulatorImages,
  sendSimulatorMessage,
} from '../api/simulator.js'
import type { SimulatorStatus, SimulatorTurn } from '../api/types.js'
import { useSession } from '../lib/session.js'

/** Si la pestaña Pruebas existe para este negocio, y sus versiones en prueba. */
export function useSimulatorStatus() {
  const session = useSession()
  return useQuery<SimulatorStatus>({
    queryKey: ['simulator', session.businessId],
    queryFn: () => getSimulatorStatus(session),
    // Depende de una variable del servidor y de los archivos del repo: no cambia sin un deploy.
    staleTime: Number.POSITIVE_INFINITY,
  })
}

/** Un mensaje tuyo y, cuando llega, el turno de Emma que lo respondió. */
export interface SimulatorEntry {
  id: number
  text: string
  /**
   * Las fotos que mandaste, como links locales del navegador: se ven acá y no
   * se suben a ningún lado.
   */
  images: string[]
  turn: SimulatorTurn | null
  error: string | null
}

export interface SimulatorChat {
  entries: SimulatorEntry[]
  sending: boolean
  /** Si Emma quedó apagada en este chat (por ejemplo, después de la foto del pago). */
  emmaPaused: boolean
  resumeError: string | null
  send: (text: string) => Promise<void>
  sendImages: (files: File[], caption: string) => Promise<void>
  resume: () => Promise<void>
  /** Descarta la conversación: el próximo mensaje es de un cliente de prueba nuevo. */
  reset: () => void
}

function errorText(cause: unknown, fallback: string): string {
  return cause instanceof PanelApiError && cause.userMessage ? cause.userMessage : fallback
}

// Estado local de la página y no de React Query: es una conversación que existe
// mientras la pantalla está abierta, no un dato del servidor que haya que
// sincronizar. Recargar es empezar de cero, igual que "Nueva conversación".
// `version` queda fija para la conversación: la página monta una nueva al cambiarla.
export function useSimulatorChat(version: string | null): SimulatorChat {
  const session = useSession()
  const [entries, setEntries] = useState<SimulatorEntry[]>([])
  const [sending, setSending] = useState(false)
  const [emmaPaused, setEmmaPaused] = useState(false)
  const [resumeError, setResumeError] = useState<string | null>(null)
  const sessionId = useRef<string | null>(null)
  const nextId = useRef(1)
  const objectUrls = useRef<string[]>([])

  // Los links locales de las fotos ocupan memoria hasta que se sueltan.
  const releaseImages = (): void => {
    for (const url of objectUrls.current) URL.revokeObjectURL(url)
    objectUrls.current = []
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: solo al desmontar
  useEffect(() => releaseImages, [])

  const patch = (id: number, change: Partial<SimulatorEntry>): void => {
    setEntries((current) => current.map((e) => (e.id === id ? { ...e, ...change } : e)))
  }

  const ensureSession = async (): Promise<string> => {
    if (!sessionId.current) {
      sessionId.current = (await createSimulatorSession(session)).sessionId
    }
    return sessionId.current
  }

  const run = async (
    entry: Omit<SimulatorEntry, 'id' | 'turn' | 'error'>,
    call: (id: string) => Promise<SimulatorTurn>,
  ): Promise<void> => {
    const id = nextId.current++
    setEntries((current) => [...current, { ...entry, id, turn: null, error: null }])
    setSending(true)
    try {
      const turn = await call(await ensureSession())
      patch(id, { turn })
      setEmmaPaused(turn.emmaPaused)
    } catch (cause) {
      patch(id, { error: errorText(cause, 'No se pudo obtener la respuesta de Emma.') })
    } finally {
      setSending(false)
    }
  }

  const send = (text: string): Promise<void> =>
    run({ text, images: [] }, (id) => sendSimulatorMessage(session, id, version, text))

  const sendImages = (files: File[], caption: string): Promise<void> => {
    const urls = files.map((file) => URL.createObjectURL(file))
    objectUrls.current.push(...urls)
    const text = caption.trim()
    return run({ text, images: urls }, (id) =>
      sendSimulatorImages(session, id, version, files.length, text || undefined),
    )
  }

  const resume = async (): Promise<void> => {
    if (!sessionId.current) return
    setSending(true)
    setResumeError(null)
    try {
      await resumeSimulatorEmma(session, sessionId.current)
      setEmmaPaused(false)
    } catch (cause) {
      setResumeError(errorText(cause, 'No se pudo reactivar a Emma.'))
    } finally {
      setSending(false)
    }
  }

  const reset = (): void => {
    sessionId.current = null
    releaseImages()
    setEmmaPaused(false)
    setResumeError(null)
    setEntries([])
  }

  return { entries, sending, emmaPaused, resumeError, send, sendImages, resume, reset }
}
