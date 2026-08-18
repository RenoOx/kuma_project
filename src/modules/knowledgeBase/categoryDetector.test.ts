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
      expect(detectCategories(message, 'general')[0], `message: ${message}`).toBe(expected)
    }
  })

  it('ranks the strongest category first when a message spans several', () => {
    // Three price keywords ("precio", "cuesta", "promocion") against one
    // location keyword ("donde").
    const result = detectCategories('donde vi el precio? cuánto cuesta con la promoción', 'general')
    expect(result[0]).toBe('precios')
    expect(result).toContain('ubicacion')
  })

  it('returns nothing when no keyword matches, so the caller can fall back', () => {
    expect(detectCategories('hola buenas tardes', 'general')).toEqual([])
    expect(detectCategories('', 'general')).toEqual([])
    expect(detectCategories('   ', 'general')).toEqual([])
  })

  it('does not fire on a keyword embedded in a longer word', () => {
    // "vale" is a price keyword; "Valentina" must not trigger it.
    expect(detectCategories('mi nombre es Valentina', 'general')).toEqual([])
  })

  it('applies the base vocabulary regardless of niche — specialization only adds words', () => {
    // "ofrecen" and "cuesta" are generic (BASE_SERVICIOS / BASE_PRECIOS), so
    // they must still fire even for a niche with a narrower, specific list.
    expect(detectCategories('qué servicios ofrecen?', 'dental')[0]).toBe('servicios')
    expect(detectCategories('cuánto cuesta?', 'barberia')[0]).toBe('precios')
  })

  it('detects niche-specific vocabulary that the generic list does not cover', () => {
    // "me duele la muela" — dental adds pain/symptom words to informacion_general
    // that no other niche (nor the generic base) carries.
    expect(detectCategories('me duele la muela', 'dental')).toEqual(['informacion_general'])
    // Under any other niche the same message matches nothing.
    expect(detectCategories('me duele la muela', 'barberia')).toEqual([])
  })

  it('dental: "cuánto cuesta un blanqueamiento" detects both servicios and precios', () => {
    const result = detectCategories('cuánto cuesta un blanqueamiento', 'dental')
    expect(result).toContain('servicios')
    expect(result).toContain('precios')
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
