import { describe, expect, it } from 'vitest'
import { renderFixedMessage, renderStaticMessage, stepOwesFixedMessage } from './fixedMessage.js'

// El mensaje fijo existe para que ningún monto pase por la IA: estos tests
// cuidan que el código tampoco invente uno cuando el servicio no lo tiene.

const service = (priceMin: number | null, priceMax: number | null, requiresEvaluation = false) => ({
  name: 'Certificación - 1 a 2 máquinas',
  priceMin,
  priceMax,
  requiresEvaluation,
})

describe('renderFixedMessage', () => {
  it('fills {precio} and {servicio} from a fixed-price service', () => {
    const result = renderFixedMessage('{servicio}: por solo S/. {precio}', service(295, 295))
    expect(result).toEqual({ ok: true, text: 'Certificación - 1 a 2 máquinas: por solo S/. 295' })
  })

  it('refuses {precio} for a price range instead of picking one', () => {
    const result = renderFixedMessage('Por solo S/. {precio}', service(295, 499))
    expect(result.ok).toBe(false)
  })

  it('refuses {precio} for a service that requires evaluation', () => {
    expect(renderFixedMessage('S/. {precio}', service(295, 295, true)).ok).toBe(false)
  })

  it('refuses {precio} for a service without a price', () => {
    expect(renderFixedMessage('S/. {precio}', service(null, null)).ok).toBe(false)
  })

  it('sends a template without {precio} even when the price is a range', () => {
    expect(renderFixedMessage('Te cuento de {servicio}', service(295, 499))).toEqual({
      ok: true,
      text: 'Te cuento de Certificación - 1 a 2 máquinas',
    })
  })

  it('refuses an unknown marker rather than sending it to the customer', () => {
    const result = renderFixedMessage('Hola {nombre}', service(295, 295))
    expect(result).toEqual({ ok: false, reason: 'marcador desconocido {nombre}' })
  })
})

describe('renderStaticMessage', () => {
  it('sends the text as written', () => {
    expect(renderStaticMessage('Hola 👋 soy Nicole')).toEqual({
      ok: true,
      text: 'Hola 👋 soy Nicole',
    })
  })

  it('refuses any marker: there is no service to fill it from', () => {
    expect(renderStaticMessage('Desde S/. {precio}').ok).toBe(false)
    expect(renderStaticMessage('Te cuento de {servicio}').ok).toBe(false)
  })
})

describe('stepOwesFixedMessage', () => {
  const step = { fixedMessages: ['beneficiosCertificado'] }

  it('owes one when the step was entered this turn and nothing went out', () => {
    expect(stepOwesFixedMessage(step, true, 0)).toBe(true)
  })

  it('owes nothing once one went out', () => {
    expect(stepOwesFixedMessage(step, true, 1)).toBe(false)
  })

  it('owes nothing when the step was entered on an earlier turn', () => {
    expect(stepOwesFixedMessage(step, false, 0)).toBe(false)
  })

  it('owes nothing when the step has no fixed messages', () => {
    expect(stepOwesFixedMessage({}, true, 0)).toBe(false)
    expect(stepOwesFixedMessage({ fixedMessages: [] }, true, 0)).toBe(false)
  })
})
