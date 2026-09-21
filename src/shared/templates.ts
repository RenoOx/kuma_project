import { logger } from '@/config/logger.js'

// Interpolation for the messages the owner writes in the panel.
//
// Deliberately not a template engine: the input is a textarea a shop owner typed
// into, so the only thing it has to do is substitute a closed set of names and
// never evaluate anything. No expressions, no property access, no loops.

export const TEMPLATE_VARIABLES = [
  'nombre_negocio',
  'nombre_cliente',
  'hora',
  'fecha',
  'servicio',
] as const

export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number]

export type TemplateVars = Partial<Record<TemplateVariable, string>>

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g

function isTemplateVariable(name: string): name is TemplateVariable {
  return (TEMPLATE_VARIABLES as readonly string[]).includes(name)
}

/**
 * Fills a configured message with the values available at this call site.
 *
 * Two kinds of miss, handled differently on purpose:
 *
 *   - An unknown name is left EXACTLY as written. `{nombre_del_cliente}` is a
 *     typo, and showing it back to the owner in the message is how they find out;
 *     silently deleting it would leave them wondering why their text came out
 *     wrong with nothing to point at.
 *   - A known name with no value for this message is removed. Not every call site
 *     knows the customer's name, and "Hola {nombre_cliente}" reaching a customer
 *     with the braces intact is the worst of the three outcomes. Write templates
 *     so they still read correctly without their variables.
 *
 * Runs of whitespace left behind by a removal are collapsed, so a dropped
 * variable does not show up as a double space mid-sentence.
 */
export function renderTemplate(text: string, vars: TemplateVars = {}): string {
  const filled = text.replace(PLACEHOLDER, (match, name: string) => {
    if (!isTemplateVariable(name)) {
      logger.warn({ variable: name }, 'unknown variable in a configured message, left as written')
      return match
    }
    return vars[name] ?? ''
  })

  return filled.replace(/[ \t]{2,}/g, ' ').trim()
}
