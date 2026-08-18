import { env } from '@/config/env.js'

// Debounce for message bursts from one sender.
//
// People do not write one message per thought on WhatsApp — they send "te dije
// que todavía" and then "reagendala" a second apart. Answering each fragment on
// its own produced replies to half a sentence, and the second fragment then
// landed on a conversation Emma had already answered wrong.
//
// So a text message does not go straight through: it waits, and any further
// text from the same sender restarts the wait. When the pause finally holds,
// the whole burst is joined into one turn.
//
// In memory on purpose, like the dedup and lock maps next to it: the buffer only
// has to outlive a few seconds, and a redeploy mid-burst costs one fragmented
// turn. Multi-instance would need this centralised — same caveat as clientRegistry.

/** Tunable per environment; see MESSAGE_DEBOUNCE_MS in config/env. */
export const MESSAGE_DEBOUNCE_MS = env.MESSAGE_DEBOUNCE_MS

interface PendingBurst {
  texts: string[]
  timer: NodeJS.Timeout
  /** Resolver of the only call still entitled to process the joined text. */
  resolve: (joined: string | null) => void
}

const bursts = new Map<string, PendingBurst>()

function flush(key: string): void {
  const burst = bursts.get(key)
  if (!burst) return
  // Delete BEFORE resolving so a message arriving in the same tick as the
  // handler starts a clean burst instead of appending to one already flushed.
  bursts.delete(key)
  burst.resolve(burst.texts.join('\n'))
}

/**
 * Adds `text` to the sender's pending burst and waits for the pause to hold.
 *
 * Resolves with the joined text for the ONE caller that ends the burst, and with
 * `null` for every earlier caller it absorbed. Callers that get `null` must
 * return without processing anything — their content is already carried by the
 * winner.
 *
 * Absorbed callers are settled immediately rather than left pending: Baileys
 * awaits this handler (`await handler(m)` in baileys.client), so a promise that
 * never settles would strand a dispatch for every superseded message. Resolving
 * them with the same joined text instead would be worse still — the burst would
 * be processed once per fragment and the customer would get duplicate replies.
 */
export function bufferMessage(key: string, text: string): Promise<string | null> {
  return new Promise((resolve) => {
    const existing = bursts.get(key)

    if (existing) {
      clearTimeout(existing.timer)
      existing.resolve(null)
      existing.texts.push(text)
      existing.resolve = resolve
      existing.timer = setTimeout(() => flush(key), MESSAGE_DEBOUNCE_MS)
      return
    }

    bursts.set(key, {
      texts: [text],
      resolve,
      timer: setTimeout(() => flush(key), MESSAGE_DEBOUNCE_MS),
    })
  })
}

/**
 * Test-only: drops every pending burst, settling its waiter with null so no
 * test is left awaiting a timer from a previous case.
 */
export function _resetBufferForTests(): void {
  for (const [key, burst] of bursts) {
    clearTimeout(burst.timer)
    burst.resolve(null)
    bursts.delete(key)
  }
}
