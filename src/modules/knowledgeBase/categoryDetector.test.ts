import { describe, expect, it } from 'vitest'
import { detectCategories, matchesTriggerKeywords, normalize } from './categoryDetector.js'

describe('normalize', () => {
  it('strips accents so stored and typed forms match', () => {
    expect(normalize('Ubicación')).toBe('ubicacion')
    expect(normalize('POLÍTICAS')).toBe('politicas')
  })

  it('strips punctuation so a trailing question mark never blocks a match', () => {
    expect(normalize('¿Dónde están?')).toBe('donde estan')
  })
})

describe('detectCategories', () => {
  it('detects each category from a realistic customer message', () => {
    const cases: Array<[string, string]> = [
      ['¿Dónde quedan? no encuentro la dirección', 'ubicacion'],
      ['qué servicios ofrecen?', 'servicios'],
      ['cuánto cuesta el corte', 'precios'],
      ['puedo cancelar la cita? cobran penalidad', 'politicas'],
      ['me pasas otro número de contacto', 'contacto'],
      ['quién es la propietaria del local', 'informacion_general'],
    ]
    for (const [message, expected] of cases) {
      expect(detectCategories(message)[0], `message: ${message}`).toBe(expected)
    }
  })

  it('ranks the strongest category first when a message spans several', () => {
    // Three price keywords ("precio", "cuesta", "promocion") against one
    // location keyword ("donde").
    const result = detectCategories('donde vi el precio? cuánto cuesta con la promoción')
    expect(result[0]).toBe('precios')
    expect(result).toContain('ubicacion')
  })

  it('returns nothing when no keyword matches, so the caller can fall back', () => {
    expect(detectCategories('hola buenas tardes')).toEqual([])
    expect(detectCategories('')).toEqual([])
    expect(detectCategories('   ')).toEqual([])
  })

  it('does not fire on a keyword embedded in a longer word', () => {
    // "vale" is a price keyword; "Valentina" must not trigger it.
    expect(detectCategories('mi nombre es Valentina')).toEqual([])
  })
})

describe('matchesTriggerKeywords', () => {
  it('matches regardless of accents and casing', () => {
    expect(matchesTriggerKeywords('hay estacionamiento?', ['Estacionamiento'])).toBe(true)
    expect(matchesTriggerKeywords('tienen cochera', ['cochería', 'cochera'])).toBe(true)
  })

  it('is false for null, empty, and non-matching keyword lists', () => {
    expect(matchesTriggerKeywords('hola', null)).toBe(false)
    expect(matchesTriggerKeywords('hola', [])).toBe(false)
    expect(matchesTriggerKeywords('hola', ['parqueo'])).toBe(false)
  })

  it('does not fire on a keyword embedded in a longer word', () => {
    expect(matchesTriggerKeywords('parqueadero municipal', ['parqueo'])).toBe(false)
  })
})
