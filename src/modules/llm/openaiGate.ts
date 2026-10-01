import { APIConnectionError, APIError } from 'openai'
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions.js'
import { env } from '@/config/env.js'
import { logger } from '@/config/logger.js'
import { openai } from './openai.client.js'

// El freno de velocidad hacia OpenAI.
//
// La cuenta de OpenAI tiene un límite de tokens por minuto (200.000), y es UNO
// para todos los negocios. Pasarlo no da una respuesta lenta: da un rechazo
// (429), y con 2 reintentos rápidos dentro de 30 s el cliente terminaba
// recibiendo "Mmm, algo no salió bien". Prueba del 2026-09-30: 189 de 903
// turnos así.
//
// Dos piezas:
// 1. Una ventana de 60 s con el presupuesto (OPENAI_TPM_BUDGET). Antes de cada
//    llamado se reserva su costo estimado; si no entra, el llamado espera en
//    fila a que la ventana libere lugar, en vez de chocar.
// 2. Si igual llega un 429 (otra cosa usando la cuenta, una estimación corta),
//    se espera lo que OpenAI dice (`retry-after`) y se reintenta, hasta el plazo
//    del turno.
//
// En memoria, como la cola de envío: con una sola instancia, la ventana ES la
// cuenta. Multi-instancia necesitaría centralizarla.

const WINDOW_MS = 60_000
// Por llamado: si OpenAI no contesta en esto, se corta ese intento.
const ATTEMPT_TIMEOUT_MS = 30_000
// Sin `retry-after`, cuánto esperar antes de reintentar un 429 o un 5xx.
const FALLBACK_RETRY_MS = 2_000
// Caracteres por token, a la baja: el español tokeniza ~3,6; contar de más
// solo hace esperar un poco antes, contar de menos es chocar.
const CHARS_PER_TOKEN = 3

interface Reservation {
  id: number
  at: number
  tokens: number
}

/**
 * La ventana de tokens por minuto. Pura salvo el reloj, que se inyecta para
 * poder probarla sin esperar minutos reales.
 */
export class TokenWindow {
  private entries: Reservation[] = []
  private nextId = 1
  // Las reservas pasan de a una y en orden de llegada: un turno que espera no
  // pierde su lugar contra uno que llega después y justo entra.
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly budget: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** Tokens reservados en los últimos 60 s. */
  used(): number {
    this.prune()
    return this.entries.reduce((sum, e) => sum + e.tokens, 0)
  }

  /**
   * Reserva `tokens` en la ventana, esperando lo necesario. Devuelve el id de la
   * reserva, o null si para entrar habría que esperar más allá de `deadline`.
   * Un pedido más grande que el presupuesto entero entra cuando la ventana está
   * vacía: si no, no entraría nunca.
   */
  acquire(tokens: number, deadline: number): Promise<number | null> {
    const run = this.queue.then(() => this.waitAndReserve(tokens, deadline))
    this.queue = run.catch(() => null)
    return run
  }

  /** Corrige una reserva con lo que el llamado costó de verdad. */
  settle(id: number, tokens: number): void {
    const entry = this.entries.find((e) => e.id === id)
    if (entry) entry.tokens = tokens
  }

  private async waitAndReserve(tokens: number, deadline: number): Promise<number | null> {
    for (;;) {
      const wait = this.waitFor(tokens)
      if (wait === 0) {
        const id = this.nextId++
        this.entries.push({ id, at: this.now(), tokens })
        return id
      }
      if (this.now() + wait > deadline) return null
      await this.sleep(wait)
    }
  }

  /** Cuánto falta para que `tokens` entre en la ventana (0 = ya entra). */
  private waitFor(tokens: number): number {
    this.prune()
    let used = this.entries.reduce((sum, e) => sum + e.tokens, 0)
    if (used + tokens <= this.budget || this.entries.length === 0) return 0
    // Se van liberando las reservas más viejas hasta que entra.
    const now = this.now()
    for (const entry of this.entries) {
      used -= entry.tokens
      if (used + tokens <= this.budget) return Math.max(1, entry.at + WINDOW_MS - now)
    }
    // Ni vacía entra: esperar a que se vaya la última.
    const last = this.entries[this.entries.length - 1]
    return last ? Math.max(1, last.at + WINDOW_MS - now) : 0
  }

  private prune(): void {
    const cutoff = this.now() - WINDOW_MS
    this.entries = this.entries.filter((e) => e.at > cutoff)
  }
}

const budgetWindow = new TokenWindow(env.OPENAI_TPM_BUDGET)

/**
 * Lo que OpenAI cuenta contra el límite al recibir el pedido: el texto que va
 * más `max_tokens` (lo reserva entero aunque la respuesta sea corta).
 */
export function estimateRequestTokens(body: ChatCompletionCreateParamsNonStreaming): number {
  const chars = JSON.stringify(body.messages).length + JSON.stringify(body.tools ?? []).length
  return Math.ceil(chars / CHARS_PER_TOKEN) + (body.max_tokens ?? 0)
}

/** OpenAI no estuvo disponible dentro del plazo del turno. */
export class OpenAIUnavailableError extends Error {
  constructor(
    readonly reason: 'rate_limited' | 'timeout' | 'upstream_error',
    message: string,
  ) {
    super(message)
    this.name = 'OpenAIUnavailableError'
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Cuánto pide OpenAI que se espere antes de reintentar, si lo dice. */
function retryAfterMs(error: APIError): number | null {
  const ms = Number(error.headers?.get('retry-after-ms'))
  if (Number.isFinite(ms) && ms > 0) return ms
  const seconds = Number(error.headers?.get('retry-after'))
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000
  return null
}

/** Errores que se arreglan esperando: límite de velocidad, caída momentánea, red. */
function isRetryable(error: unknown): error is APIError {
  if (error instanceof APIConnectionError) return true
  if (!(error instanceof APIError)) return false
  // Un 429 por cuota agotada (sin saldo) no se arregla esperando.
  if (error.status === 429) return error.code !== 'insufficient_quota'
  return typeof error.status === 'number' && error.status >= 500
}

/**
 * Un llamado a OpenAI que respeta el freno y reintenta lo reintentable hasta
 * `deadline` (epoch ms). Tira OpenAIUnavailableError si no lo logra a tiempo;
 * cualquier otro error (un 400, un pedido mal armado) sale tal cual, sin
 * reintentar: no se arregla esperando.
 */
export async function createChatCompletion(
  body: ChatCompletionCreateParamsNonStreaming,
  deadline: number,
): Promise<ChatCompletion> {
  const estimate = estimateRequestTokens(body)
  for (let attempt = 1; ; attempt++) {
    const reservation = await budgetWindow.acquire(estimate, deadline)
    if (reservation === null) {
      throw new OpenAIUnavailableError(
        'rate_limited',
        `token budget full until past the turn deadline (estimate ${estimate})`,
      )
    }

    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new OpenAIUnavailableError('timeout', 'turn deadline reached')
    try {
      const completion = await openai.chat.completions.create(body, {
        signal: AbortSignal.timeout(Math.min(ATTEMPT_TIMEOUT_MS, remaining)),
        // Los reintentos los hace este archivo, que sabe del plazo del turno.
        maxRetries: 0,
      })
      budgetWindow.settle(
        reservation,
        (completion.usage?.prompt_tokens ?? estimate) + (body.max_tokens ?? 0),
      )
      return completion
    } catch (cause) {
      if (
        cause instanceof Error &&
        (cause.name === 'TimeoutError' || cause.name === 'AbortError')
      ) {
        throw new OpenAIUnavailableError('timeout', cause.message)
      }
      if (!isRetryable(cause)) throw cause
      const wait =
        (cause.status === 429 ? retryAfterMs(cause) : null) ?? FALLBACK_RETRY_MS * attempt
      logger.warn(
        { component: 'openaiGate', status: cause.status ?? null, attempt, waitMs: wait },
        'openai call refused, retrying within the turn deadline',
      )
      if (Date.now() + wait >= deadline) {
        throw new OpenAIUnavailableError(
          cause.status === 429 ? 'rate_limited' : 'upstream_error',
          cause.message,
        )
      }
      await sleep(wait)
    }
  }
}
