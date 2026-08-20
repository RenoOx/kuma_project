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
  it('detects each active category from a realistic customer message', () => {
    const cases: Array<[string, string]> = [
      ['puedo cancelar la cita? cobran penalidad', 'politicas'],
      ['tienen alguna promoción este mes?', 'promociones'],
      ['quién es la propietaria del local', 'informacion_general'],
    ]
    for (const [message, expected] of cases) {
      expect(detectCategories(message, 'general')[0], `message: ${message}`).toBe(expected)
    }
  })

  // Services, prices, hours, address and contact details are answered from
  // business settings. Routing them to the knowledge base is what let Emma read
  // two different answers to the same question.
  it('does not route questions that business settings already answer', () => {
    for (const message of [
      '¿Dónde quedan? no encuentro la dirección',
      'qué servicios ofrecen?',
      'cuánto cuesta el corte',
      'me pasas otro número de contacto',
    ]) {
      expect(detectCategories(message, 'general'), `message: ${message}`).toEqual([])
    }
  })

  it('ranks the strongest category first when a message spans several', () => {
    // Three promo keywords ("promocion", "descuento", "combo") against one
    // policy keyword ("pago").
    const result = detectCategories(
      'la promoción con descuento del combo acepta pago en efectivo?',
      'general',
    )
    expect(result[0]).toBe('promociones')
    expect(result).toContain('politicas')
  })

  it('returns nothing when no keyword matches, so the caller can fall back', () => {
    expect(detectCategories('hola buenas tardes', 'general')).toEqual([])
    expect(detectCategories('', 'general')).toEqual([])
    expect(detectCategories('   ', 'general')).toEqual([])
  })

  it('does not fire on a keyword embedded in a longer word', () => {
    // "combo" is a promo keyword; "combose" must not trigger it.
    expect(detectCategories('mi apellido es Combose', 'general')).toEqual([])
  })

  it('applies the base vocabulary regardless of niche — specialization only adds words', () => {
    // "propietaria" is generic (BASE_INFORMACION_GENERAL), so it must still fire
    // for a niche that carries its own narrower list on top.
    expect(detectCategories('quién es la propietaria', 'dental')[0]).toBe('informacion_general')
    expect(detectCategories('tienen descuento?', 'barberia')[0]).toBe('promociones')
  })

  it('detects niche-specific vocabulary that the generic list does not cover', () => {
    // "me duele la muela" — dental adds pain/symptom words to informacion_general
    // that no other niche (nor the generic base) carries.
    expect(detectCategories('me duele la muela', 'dental')).toEqual(['informacion_general'])
    // Under any other niche the same message matches nothing.
    expect(detectCategories('me duele la muela', 'barberia')).toEqual([])
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
