import { describe, expect, it } from 'vitest'
import tecmin from '@/config/businesses/instituto-tecmin.js'
import { type EscalationGate, escalationAllowed, normalizeForGate } from './escalationGate.js'

// Con los patrones REALES de Tecmin: lo que se prueba es la regla del negocio,
// no un ejemplo inventado. Los mensajes de "rechaza" son los de producción que
// terminaron en "Te paso con un asesor" (1/10, 13:39 y 14:03).
function tecminGate(): EscalationGate {
  if (!tecmin.escalationGate) throw new Error('Tecmin tiene que declarar escalationGate')
  return tecmin.escalationGate
}
const gate = tecminGate()

const ADVISOR = 'Esa consulta te la confirma el asesor 😊'

function allowed(customerText: string, previousAssistantText: string | null = null): boolean {
  return escalationAllowed({ customerText, previousAssistantText, gate }).allowed
}

describe('escalationAllowed — Tecmin', () => {
  it.each([
    'Si claro dan boleta descuento?',
    'SI CALRO, COMO , ES DAN FACTURA BOLETA?',
    'dale, cómo pago?',
    'C y dan factura?',
    'tengo experiencia, ¿cuánto demora?',
    'puedo ir y pagar en persona?',
    '¿con el certificado me contratan en una empresa?',
    'las clases son personalizadas?',
    '¿cómo se llama el curso?',
  ])('rechaza sin motivo real: %s', (text) => {
    expect(allowed(text)).toBe(false)
  })

  it.each([
    'quiero hablar con un asesor',
    '¿me puede llamar alguien?',
    'pásame con una persona',
    'me das el número del asesor?',
    'somos una empresa con 6 operarios',
    'soy alumno del avanzado, a qué hora es mi práctica?',
    'si pago y no puedo, ¿me devuelven?',
    'esto es una estafa',
  ])('permite con motivo real: %s', (text) => {
    expect(allowed(text)).toBe(true)
  })

  it('permite cuando insiste después de la frase del asesor', () => {
    expect(allowed('pero dan factura o no?', ADVISOR)).toBe(true)
  })

  it('no cuenta como insistencia si el mensaje anterior fue otro', () => {
    expect(
      allowed('pero dan factura o no?', 'Te comento que este Lunes empezamos las clases.'),
    ).toBe(false)
  })
})

describe('normalizeForGate', () => {
  it('saca tildes, mayúsculas y espacios de más', () => {
    expect(normalizeForGate('  Llámame   AHORA ')).toBe('llamame ahora')
  })
})
