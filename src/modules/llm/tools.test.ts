import { describe, expect, it } from 'vitest'
import { kumaTools, withBusinessEscalation } from './tools.js'

// El "cuándo escalar" de un negocio reemplaza al genérico SOLO en su herramienta
// de escalar. Tecmin, 2026-09-30: el genérico decía "pregunta por pagos" y Emma
// escalaba a leads que preguntaban "¿cómo pago?" listos para cerrar.

function tool(name: string) {
  const found = kumaTools.find((t) => t.type === 'function' && t.function.name === name)
  if (!found) throw new Error(`no tool ${name}`)
  return found
}

function descriptionOf(t: ReturnType<typeof tool>): string {
  return t.type === 'function' ? (t.function.description ?? '') : ''
}

describe('withBusinessEscalation', () => {
  it('replaces the generic "when" of escalate_to_human with the business one', () => {
    const result = withBusinessEscalation(
      tool('escalate_to_human'),
      'Usala SOLO si pide una persona.',
    )
    expect(descriptionOf(result)).toContain('Usala SOLO si pide una persona.')
    expect(descriptionOf(result)).not.toContain('pregunta por pagos')
  })

  it('leaves escalate_to_human untouched for a business without its own rule', () => {
    const original = tool('escalate_to_human')
    expect(withBusinessEscalation(original, undefined)).toBe(original)
  })

  it('never touches other tools', () => {
    const original = tool('show_services')
    expect(withBusinessEscalation(original, 'Usala SOLO si pide una persona.')).toBe(original)
  })
})
