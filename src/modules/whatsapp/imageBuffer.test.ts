import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  _resetImageBufferForTests,
  bufferImage,
  flushImagesNow,
  IMAGE_DEBOUNCE_MS,
} from './imageBuffer.js'

// Timers falsos, igual que en messageBuffer.test.ts: el buffer no toca la base.
describe('imageBuffer.bufferImage', () => {
  const KEY = 'biz-1:+51999000111'

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    _resetImageBufferForTests()
    vi.useRealTimers()
  })

  it('junta el DNI de frente y de reverso en un grupo, y deja pasar a UN solo llamador', async () => {
    const first = bufferImage(KEY, 'frente')
    await vi.advanceTimersByTimeAsync(IMAGE_DEBOUNCE_MS / 4)
    const second = bufferImage(KEY, 'reverso')
    await vi.advanceTimersByTimeAsync(IMAGE_DEBOUNCE_MS)

    const results = await Promise.all([first, second])
    expect(results[0]).toBeNull()
    expect(results[1]).toEqual(['frente', 'reverso'])
  })

  it('cada foto nueva reinicia la espera: un grupo largo sigue siendo uno', async () => {
    const pending: Array<Promise<string[] | null>> = []
    for (let i = 1; i <= 3; i++) {
      pending.push(bufferImage(KEY, `foto${i}`))
      await vi.advanceTimersByTimeAsync(IMAGE_DEBOUNCE_MS / 2)
    }
    await vi.advanceTimersByTimeAsync(IMAGE_DEBOUNCE_MS)

    const delivered = (await Promise.all(pending)).filter((r) => r !== null)
    expect(delivered).toEqual([['foto1', 'foto2', 'foto3']])
  })

  it('flushImagesNow entrega el grupo en el acto (un texto del cliente lo cierra)', async () => {
    const pending = bufferImage(KEY, 'dni')
    flushImagesNow(KEY)
    expect(await pending).toEqual(['dni'])
    // Sin grupo pendiente no hace nada ni rompe.
    expect(() => flushImagesNow(KEY)).not.toThrow()
  })

  it('no mezcla remitentes ni negocios', async () => {
    const a = bufferImage('biz-1:+51111', 'A')
    const b = bufferImage('biz-2:+51111', 'B')
    await vi.advanceTimersByTimeAsync(IMAGE_DEBOUNCE_MS)
    expect(await a).toEqual(['A'])
    expect(await b).toEqual(['B'])
  })
})
