import { AsyncLocalStorage } from 'node:async_hooks'

// Un turno del simulador corre adentro de este contexto, y todo lo que se llama
// desde ahí (llm.service, el executor, los notificadores) lo ve sin recibirlo
// por parámetro. Dos cosas dependen de él:
//
// - Qué archivo corre: flowSource devuelve la versión en prueba elegida en vez
//   de la de siempre. WhatsApp nunca abre este contexto, así que nunca la recibe.
// - Que nada salga por WhatsApp: en prod el dueño tiene número real y el socket
//   está conectado, así que una escalada de prueba le escribiría de verdad.
//
// Es por negocio: el contexto lleva su businessId y quien lo lee lo compara.

export interface SimulationScope {
  businessId: string
  /** La versión en prueba elegida (`test.id` del archivo); null = la de siempre. */
  versionId: string | null
}

const storage = new AsyncLocalStorage<SimulationScope>()

export function runSimulation<T>(scope: SimulationScope, fn: () => Promise<T>): Promise<T> {
  return storage.run(scope, fn)
}

/** El contexto del simulador, si este código corre dentro de un turno de prueba. */
export function simulationScope(): SimulationScope | undefined {
  return storage.getStore()
}
