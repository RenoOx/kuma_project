import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MESSAGE_DEBOUNCE_MS,
  _resetBufferForTests,
  bufferMessage,
} from './messageBuffer.js'

// Fake timers are safe in this file specifically: messageBuffer holds no DB
// handle, so freezing setTimeout cannot stall postgres-js the way it would in
// the repo-backed suites.
describe('messageBuffer.bufferMessage', () => {
  const KEY = 'biz-1:+51999000111'

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    _resetBufferForTests()
    vi.useRealTimers()
  })

  it('folds a two-message burst into one turn and lets exactly ONE caller through', async () => {
    // The reported case: a thought split across two messages a second apart.
    const first = bufferMessage(KEY, 'te dije que todavia')
    await vi.advanceTimersByTimeAsync(MESSAGE_DEBOUNCE_MS / 4)
    const second = bufferMessage(KEY, 'reagendala')
    await vi.advanceTimersByTimeAsync(MESSAGE_DEBOUNCE_MS)

    const results = await Promise.all([first, second])

    expect(results[0]).toBeNull()
    expect(results[1]).toBe('te dije que todavia\nreagendala')
    // The whole point of resolving absorbed callers with null. Handing them the
    // joined text instead would run the burst once per fragment and send the
    // customer duplicate replies — the exact bug the dedup map already guards.
    expect(results.filter((r) => r !== null)).toHaveLength(1)
  })

  it('restarts the wait on every new message, so a long burst stays one turn', async () => {
    const pending: Array<Promise<string | null>> = []
    for (let i = 1; i <= 5; i++) {
      pending.push(bufferMessage(KEY, `m${i}`))
      // Each gap is shorter than the debounce, so the timer never expires
      // mid-burst even though the total elapsed time exceeds it.
      await vi.advanceTimersByTimeAsync(MESSAGE_DEBOUNCE_MS / 2)
    }
    await vi.advanceTimersByTimeAsync(MESSAGE_DEBOUNCE_MS)

    const results = await Promise.all(pending)
    const delivered = results.filter((r) => r !== null)

    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toBe('m1\nm2\nm3\nm4\nm5')
  })

  it('keeps senders apart: one burst never absorbs another', async () => {
    const a = bufferMessage('biz-1:+51111', 'hola A')
    const b = bufferMessage('biz-1:+52222', 'hola B')
    // Same phone under a different tenant must not share a burst either.
    const c = bufferMessage('biz-2:+51111', 'hola C')
    await vi.advanceTimersByTimeAsync(MESSAGE_DEBOUNCE_MS)

    expect(await a).toBe('hola A')
    expect(await b).toBe('hola B')
    expect(await c).toBe('hola C')
  })

  it('does not group messages separated by more than the debounce', async () => {
    const first = bufferMessage(KEY, 'primero')
    await vi.advanceTimersByTimeAsync(MESSAGE_DEBOUNCE_MS)
    expect(await first).toBe('primero')

    const second = bufferMessage(KEY, 'segundo')
    await vi.advanceTimersByTimeAsync(MESSAGE_DEBOUNCE_MS)
    expect(await second).toBe('segundo')
  })
})
