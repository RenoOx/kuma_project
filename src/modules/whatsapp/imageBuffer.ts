import { env } from '@/config/env.js'

// Agrupa las fotos que un mismo cliente manda seguidas.
//
// Mismo molde que messageBuffer.ts, pero junta fotos en vez de texto. Nació de un
// caso real (Instituto Tecmin, 2026-09-28): el cliente manda el DNI de frente y
// de reverso, cada foto se procesaba sola, y la primera apagaba a Emma en ese
// chat (`onImage.pause`) — la segunda chocaba con el gate "¿Emma apagada?" y el
// dueño nunca la recibía. Procesadas como grupo, la pausa va una sola vez al
// final y el cliente recibe un solo "¡Recibí tu imagen!".
//
// En memoria a propósito, igual que el buffer de texto: solo tiene que durar unos
// segundos, y un redeploy en medio de un grupo cuesta procesarlo partido.

/** Configurable por entorno; ver IMAGE_DEBOUNCE_MS en config/env. 0 = sin agrupar. */
export const IMAGE_DEBOUNCE_MS = env.IMAGE_DEBOUNCE_MS

interface PendingGroup<T> {
  items: T[]
  timer: NodeJS.Timeout | null
  /** El único llamador que va a procesar el grupo entero. */
  resolve: (items: T[] | null) => void
}

const groups = new Map<string, PendingGroup<unknown>>()

function flush(key: string): void {
  const group = groups.get(key)
  if (!group) return
  // Se borra ANTES de resolver: una foto que llegue en el mismo tick arranca un
  // grupo nuevo en vez de sumarse a uno que ya se entregó.
  groups.delete(key)
  if (group.timer) clearTimeout(group.timer)
  group.resolve(group.items)
}

/**
 * Suma `item` al grupo pendiente del remitente y espera a que dejen de llegar.
 *
 * Resuelve con TODAS las fotos para el llamador que cierra el grupo y con `null`
 * para cada llamador anterior que absorbió. Quien recibe `null` tiene que volver
 * sin procesar nada: su foto ya viaja en el grupo del ganador. Los absorbidos se
 * resuelven en el acto, no quedan colgados, por lo mismo que en messageBuffer:
 * Baileys espera a este handler y una promesa sin resolver lo trabaría.
 */
export function bufferImage<T>(key: string, item: T): Promise<T[] | null> {
  if (IMAGE_DEBOUNCE_MS === 0) return Promise.resolve([item])

  return new Promise((resolve) => {
    const existing = groups.get(key) as PendingGroup<T> | undefined

    if (existing) {
      if (existing.timer) clearTimeout(existing.timer)
      existing.resolve(null)
      existing.items.push(item)
      existing.resolve = resolve
      existing.timer = setTimeout(() => flush(key), IMAGE_DEBOUNCE_MS)
      return
    }

    groups.set(key, {
      items: [item],
      resolve: resolve as (items: unknown[] | null) => void,
      timer: setTimeout(() => flush(key), IMAGE_DEBOUNCE_MS),
    })
  })
}

/**
 * Cierra el grupo pendiente del remitente sin esperar. Lo llama un texto del
 * mismo cliente: "listo, ahí están" no se tiene que contestar antes de procesar
 * las fotos que vinieron antes. Sin grupo pendiente, no hace nada.
 */
export function flushImagesNow(key: string): void {
  flush(key)
}

/** Solo para tests: descarta todo grupo pendiente, resolviendo su espera con null. */
export function _resetImageBufferForTests(): void {
  for (const [key, group] of groups) {
    if (group.timer) clearTimeout(group.timer)
    group.resolve(null)
    groups.delete(key)
  }
}
