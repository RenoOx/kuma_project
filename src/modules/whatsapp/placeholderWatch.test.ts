import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { settle, watch } from './placeholderWatch.js'

describe('placeholderWatch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not fire when the content arrives in time', () => {
    const onTimeout = vi.fn()
    expect(watch('b1:m1', 15_000, onTimeout)).toBe(true)
    vi.advanceTimersByTime(1_000)
    expect(settle('b1:m1')).toBe(true)
    vi.advanceTimersByTime(60_000)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it('fires exactly once when the content never arrives', () => {
    const onTimeout = vi.fn()
    watch('b1:m2', 15_000, onTimeout)
    vi.advanceTimersByTime(14_999)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    // Ya se venció: el contenido tardío no encuentra nada que cancelar.
    expect(settle('b1:m2')).toBe(false)
  })

  it('ignores a second notice for the same message', () => {
    const first = vi.fn()
    const second = vi.fn()
    expect(watch('b1:m3', 15_000, first)).toBe(true)
    expect(watch('b1:m3', 15_000, second)).toBe(false)
    vi.advanceTimersByTime(15_000)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
  })

  it('settling an unknown key is a no-op', () => {
    expect(settle('b1:nunca')).toBe(false)
  })

  it('keeps businesses apart', () => {
    const a = vi.fn()
    const b = vi.fn()
    watch('negocioA:m4', 15_000, a)
    watch('negocioB:m4', 15_000, b)
    settle('negocioA:m4')
    vi.advanceTimersByTime(15_000)
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })
})
