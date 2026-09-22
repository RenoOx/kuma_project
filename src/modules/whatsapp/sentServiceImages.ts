// How recently a conversation has been shown a given service's files.
//
// In memory, like imageExpectation next door, and for the same trade: the cost of
// forgetting after a restart is one repeated photo, which does not justify a
// table and a write on every send. It carries the same multi-instance limitation
// as the rest of the in-memory state in this folder — two app instances would
// each keep their own map — and that is tracked as debt rather than hidden here.
//
// Without a limit the model re-sends the same picture every time the conversation
// circles back to a service, which reads as a glitch rather than as helpfulness.
//
// The limit used to be one send per service with a SIX HOUR memory, which is not
// "do not repeat" — in a WhatsApp chat that lasts minutes it is "never again". A
// customer asked about the same course 71 minutes after being shown its photo and
// got nothing, in a thread whose whole purpose was choosing between courses.
// A short rolling window says the thing that was actually meant: a second ask
// gets an answer, a customer going in circles does not get six copies.

const WINDOW_MS = 15 * 60 * 1000
const MAX_SENDS_PER_WINDOW = 2

const sent = new Map<string, number[]>()

function keyFor(conversationId: string, serviceId: string): string {
  return `${conversationId}:${serviceId}`
}

/** The sends of one pair that still fall inside the window, oldest first. */
function recent(key: string, now: number): number[] {
  const all = sent.get(key)
  if (!all) return []
  return all.filter((at) => now - at < WINDOW_MS)
}

// Pruned on access rather than on a timer: the map only grows on sends, and a
// scheduler for it would be a second thing to own for no gain.
function prune(now: number): void {
  for (const [key, timestamps] of sent) {
    const live = timestamps.filter((at) => now - at < WINDOW_MS)
    if (live.length === 0) sent.delete(key)
    else if (live.length !== timestamps.length) sent.set(key, live)
  }
}

/**
 * Whether this conversation may be sent this service's files right now.
 *
 * Named for the decision rather than for the fact behind it ("was it already
 * sent?"), because deciding is the only thing the caller does with the answer.
 */
export function canSendServiceMedia(
  conversationId: string,
  serviceId: string,
  now: number = Date.now(),
): boolean {
  prune(now)
  return recent(keyFor(conversationId, serviceId), now).length < MAX_SENDS_PER_WINDOW
}

export function markServiceImageSent(
  conversationId: string,
  serviceId: string,
  now: number = Date.now(),
): void {
  prune(now)
  const key = keyFor(conversationId, serviceId)
  sent.set(key, [...recent(key, now), now])
}

/** Test-only: the map is module state and would otherwise leak between cases. */
export function _resetSentServiceImagesForTests(): void {
  sent.clear()
}
