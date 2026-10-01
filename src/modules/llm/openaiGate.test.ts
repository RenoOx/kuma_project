import { APIError } from 'openai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createChatCompletion,
  estimateRequestTokens,
  OpenAIUnavailableError,
  TokenWindow,
} from './openaiGate.js'

// El cliente de OpenAI, reemplazado: estos tests prueban el freno y los
// reintentos, no la red.
const { create } = vi.hoisted(() => ({ create: vi.fn() }))
vi.mock('./openai.client.js', () => ({ openai: { chat: { completions: { create } } } }))

// Un reloj que solo avanza cuando la ventana "duerme": así la espera de un
// minuto se prueba en milisegundos y sin depender del tiempo real.
function fakeClock(start = 1_000_000) {
  let now = start
  const slept: number[] = []
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms)
      now += ms
    },
    advance: (ms: number) => {
      now += ms
    },
    slept,
  }
}

describe('TokenWindow', () => {
  it('reserves right away while the minute has room', async () => {
    const clock = fakeClock()
    const window = new TokenWindow(1_000, clock.now, clock.sleep)
    expect(await window.acquire(400, clock.now() + 60_000)).not.toBeNull()
    expect(await window.acquire(400, clock.now() + 60_000)).not.toBeNull()
    expect(clock.slept).toEqual([])
    expect(window.used()).toBe(800)
  })

  it('waits until the oldest reservation leaves the window when full', async () => {
    const clock = fakeClock()
    const window = new TokenWindow(1_000, clock.now, clock.sleep)
    await window.acquire(700, clock.now() + 120_000)
    clock.advance(10_000)
    await window.acquire(700, clock.now() + 120_000)
    // La primera reserva sale de la ventana 60 s después de hecha: faltaban 50 s.
    expect(clock.slept).toEqual([50_000])
  })

  it('gives up (null) when the wait would pass the deadline', async () => {
    const clock = fakeClock()
    const window = new TokenWindow(1_000, clock.now, clock.sleep)
    await window.acquire(900, clock.now() + 60_000)
    expect(await window.acquire(500, clock.now() + 5_000)).toBeNull()
  })

  it('lets a request larger than the whole budget in when the window is empty', async () => {
    const clock = fakeClock()
    const window = new TokenWindow(1_000, clock.now, clock.sleep)
    expect(await window.acquire(5_000, clock.now() + 1_000)).not.toBeNull()
  })

  it('frees room when a reservation is settled with the real, smaller cost', async () => {
    const clock = fakeClock()
    const window = new TokenWindow(1_000, clock.now, clock.sleep)
    const id = await window.acquire(900, clock.now() + 60_000)
    if (id === null) throw new Error('expected a reservation')
    window.settle(id, 300)
    await window.acquire(600, clock.now() + 60_000)
    expect(clock.slept).toEqual([])
  })
})

describe('estimateRequestTokens', () => {
  it('counts max_tokens on top of the text, as OpenAI does', () => {
    const body = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user' as const, content: 'x'.repeat(300) }],
      max_tokens: 600,
    }
    expect(estimateRequestTokens(body)).toBeGreaterThanOrEqual(600 + 100)
  })
})

describe('createChatCompletion', () => {
  const body = { model: 'gpt-4o-mini', messages: [{ role: 'user' as const, content: 'hola' }] }
  const ok = {
    choices: [{ message: { role: 'assistant', content: 'hola' } }],
    usage: { prompt_tokens: 10 },
  }

  afterEach(() => {
    create.mockReset()
  })

  it('retries a 429 after the wait OpenAI asks for, then succeeds', async () => {
    create
      .mockRejectedValueOnce(
        APIError.generate(
          429,
          { message: 'rate limited' },
          'rate limited',
          new Headers({ 'retry-after-ms': '5' }),
        ),
      )
      .mockResolvedValueOnce(ok)
    await expect(createChatCompletion(body, Date.now() + 10_000)).resolves.toBe(ok)
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('gives up with rate_limited when the requested wait passes the turn deadline', async () => {
    create.mockRejectedValue(
      APIError.generate(
        429,
        { message: 'rate limited' },
        'rate limited',
        new Headers({ 'retry-after': '60' }),
      ),
    )
    const failure = createChatCompletion(body, Date.now() + 1_000)
    await expect(failure).rejects.toBeInstanceOf(OpenAIUnavailableError)
    await expect(failure).rejects.toMatchObject({ reason: 'rate_limited' })
  })

  it('does not retry a 400: waiting does not fix a malformed request', async () => {
    create.mockRejectedValue(
      APIError.generate(400, { message: 'bad request' }, 'bad request', new Headers()),
    )
    await expect(createChatCompletion(body, Date.now() + 10_000)).rejects.toMatchObject({
      status: 400,
    })
    expect(create).toHaveBeenCalledTimes(1)
  })
})
