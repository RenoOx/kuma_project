import { describe, expect, it } from 'vitest'
import { isSandboxNumber } from './phone.js'

// Un número de prueba nunca levanta WhatsApp. Equivocarse para un lado deja un
// negocio real sin bot; para el otro, un número falso reintentando un QR. El caso
// que más importa es el celular peruano cargado sin +51, que empieza con 999.

describe('isSandboxNumber', () => {
  it('reconoce un número de prueba, con o sin el +', () => {
    expect(isSandboxNumber('+999000000001')).toBe(true)
    expect(isSandboxNumber('999000000001')).toBe(true)
  })

  it('no confunde un celular peruano cargado sin +51 con uno de prueba', () => {
    // 999 123 456 es un celular real: 9 dígitos, sin código de país.
    expect(isSandboxNumber('999123456')).toBe(false)
    expect(isSandboxNumber('+999 123 456')).toBe(false)
  })

  it('no marca números reales, aunque contengan 999', () => {
    expect(isSandboxNumber('+51999123456')).toBe(false)
    expect(isSandboxNumber('+51987654321')).toBe(false)
  })

  it('no marca un valor vacío o ausente', () => {
    expect(isSandboxNumber('')).toBe(false)
    expect(isSandboxNumber(null)).toBe(false)
    expect(isSandboxNumber(undefined)).toBe(false)
  })
})
