// Entregas vacías que esperan su contenido.
//
// El mensaje que nace de un anuncio de Meta (Click-to-WhatsApp) WhatsApp se lo
// da solo al celular: al servidor le llega un aviso sin contenido (en Baileys,
// un stub CIPHERTEXT). Baileys le pide el texto al celular y lo vuelve a entregar
// con el MISMO id un momento después. Si esa segunda entrega no llega (celular
// apagado, sin datos), el lead quedaba sin respuesta y nadie se enteraba: el
// 2026-10-10 se perdieron así 10 leads de una campaña de Tecmin.
//
// Este módulo solo lleva la cuenta: anota cada entrega vacía con un plazo, la
// borra cuando llega el contenido y, si se vence, llama al respaldo que le pasó
// el handler. En memoria a propósito, igual que el dedup de ids: un deploy en
// medio de la espera cuesta, a lo sumo, un respaldo que no se dispara.

/** Cuánto se espera el contenido antes de que Emma conteste sin él. */
export const PLACEHOLDER_WAIT_MS = 15_000

// Tope para que un número con tráfico raro no haga crecer el Map sin fin. Cada
// entrada se borra sola al vencerse, así que en la práctica nunca se acerca.
const MAX_PENDING = 1000

const pending = new Map<string, NodeJS.Timeout>()

/**
 * Anota una entrega vacía. Devuelve `false` si no se anotó: ya estaba anotada
 * (Baileys emitió el mismo aviso dos veces) o se llegó al tope.
 */
export function watch(key: string, waitMs: number, onTimeout: () => void): boolean {
  if (pending.has(key) || pending.size >= MAX_PENDING) return false
  const timer = setTimeout(() => {
    pending.delete(key)
    onTimeout()
  }, waitMs)
  // El temporizador no tiene que mantener vivo el proceso al apagarse.
  timer.unref?.()
  pending.set(key, timer)
  return true
}

/** Llegó el contenido: cancela el respaldo. Devuelve si había algo esperando. */
export function settle(key: string): boolean {
  const timer = pending.get(key)
  if (!timer) return false
  clearTimeout(timer)
  pending.delete(key)
  return true
}
