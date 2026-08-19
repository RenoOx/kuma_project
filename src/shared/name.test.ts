import { describe, expect, it } from 'vitest'
import { formatPersonName } from './name.js'

describe('formatPersonName', () => {
  it('title-cases a name typed all lowercase', () => {
    expect(formatPersonName('juan perez')).toBe('Juan Perez')
  })

  it('title-cases a name typed in caps', () => {
    expect(formatPersonName('JUAN PEREZ')).toBe('Juan Perez')
  })

  it('keeps particles lowercase unless they open the name', () => {
    // The naive title-case renders "Juan De La Cruz", which is visibly wrong
    // for a surname this common in Peru.
    expect(formatPersonName('juan de la cruz')).toBe('Juan de la Cruz')
    expect(formatPersonName('de la cruz')).toBe('De la Cruz')
  })

  it('leaves a mixed-case name untouched', () => {
    // Case here is information: the person wrote it deliberately and any
    // rewrite can only make it worse.
    expect(formatPersonName('María de los Ángeles')).toBe('María de los Ángeles')
    expect(formatPersonName('McCarthy')).toBe('McCarthy')
    expect(formatPersonName('Ana Sofía')).toBe('Ana Sofía')
  })

  it('collapses stray whitespace', () => {
    expect(formatPersonName('  juan   perez  ')).toBe('Juan Perez')
  })

  it('returns null for empty input so callers pick their own fallback', () => {
    expect(formatPersonName(null)).toBeNull()
    expect(formatPersonName(undefined)).toBeNull()
    expect(formatPersonName('')).toBeNull()
    expect(formatPersonName('   ')).toBeNull()
  })
})
