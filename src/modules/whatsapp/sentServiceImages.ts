// Which service photos a conversation has already been shown.
//
// In memory, like imageExpectation next door, and for the same trade: the cost of
// forgetting after a restart is one repeated photo, which does not justify a
// table and a write on every send. It carries the same multi-instance limitation
// as the rest of the in-memory state in this folder — two app instances would
// each keep their own map — and that is tracked as debt rather than hidden here.
//
// Without this the model re-sends the same picture every time the conversation
// circles back to a service, which reads as a glitch rather than as helpfulness.

const TTL_MS = 6 * 60 * 60 * 1000

const sent = new Map<string, number>()

function keyFor(conversationId: string, serviceId: string): string {
  return `${conversationId}:${serviceId}`
}

// Pruned on access rather than on a timer: the map only grows on sends, and a
// scheduler for it would be a second thing to own for no gain.
function prune(now: number): void {
  for (const [key, at] of sent) {
    if (now - at > TTL_MS) sent.delete(key)
  }
}

export function wasServiceImageSent(
  conversationId: string,
  serviceId: string,
  now: number = Date.now(),
): boolean {
  prune(now)
  const at = sent.get(keyFor(conversationId, serviceId))
  return at !== undefined && now - at <= TTL_MS
}

export function markServiceImageSent(
  conversationId: string,
  serviceId: string,
  now: number = Date.now(),
): void {
  prune(now)
  sent.set(keyFor(conversationId, serviceId), now)
}

/** Test-only: the map is module state and would otherwise leak between cases. */
export function _resetSentServiceImagesForTests(): void {
  sent.clear()
}
