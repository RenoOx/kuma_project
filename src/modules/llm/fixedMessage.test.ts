import { describe, expect, it } from 'vitest'
import { isSafeImageName, renderFixedMessage } from './fixedMessage.js'

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

describe('isSafeImageName', () => {
  it('accepts a plain image file name', () => {
    expect(isSafeImageName('carnet-qr.png')).toBe(true)
    expect(isSafeImageName('oferta_1.jpeg')).toBe(true)
  })

  it('rejects anything that could leave the images folder', () => {
    expect(isSafeImageName('../.env')).toBe(false)
    expect(isSafeImageName('sub/carnet.png')).toBe(false)
    expect(isSafeImageName('..\\carnet.png')).toBe(false)
    expect(isSafeImageName('.hidden.png')).toBe(false)
  })

  it('rejects files that are not images', () => {
    expect(isSafeImageName('carnet.pdf')).toBe(false)
    expect(isSafeImageName('carnet.png.exe')).toBe(false)
  })
})
