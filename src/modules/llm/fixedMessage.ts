import type { Service } from '@/modules/business/business.settings.js'

// Mensajes fijos: texto que el negocio escribió y que el código manda TAL CUAL.
//
// La IA solo decide cuándo y para qué servicio (la intención); el texto y el monto
// no pasan por ella. Nace de un caso concreto: una IA que redacta la oferta y hace
// cuentas termina diciendo precios que el negocio nunca dio.

/** Un mensaje fijo tal como lo declara el archivo del negocio. */
export interface FixedMessage {
  /**
   * El texto, con marcadores que completa el código:
   *   {precio}   el precio del servicio elegido, solo el número ("295")
   *   {servicio} el nombre del servicio elegido
   */
  text: string
  /** Una imagen de la carpeta images/ del repo que va después del texto. */
  image?: string
  /** Cuándo mandarlo, en palabras del negocio. Es lo que Emma lee en el paso. */
  when?: string
}

/** Un mensaje fijo disponible en el paso actual, con su id. */
export type StepFixedMessage = FixedMessage & { id: string }

/** Lo que sale hacia el cliente: el texto ya completo y, si hay, la imagen. */
export interface FixedOutbound {
  text: string
  image?: string
}

export type RenderResult = { ok: true; text: string } | { ok: false; reason: string }

/**
 * Completa los marcadores con los datos del servicio elegido.
 *
 * Se niega antes que inventar: {precio} exige un precio fijo (un solo monto). Un
 * rango o un "desde" no tienen un número que poner, y elegir uno sería decidir un
 * precio que el negocio no fijó.
 */
export function renderFixedMessage(
  template: string,
  service: Pick<Service, 'name' | 'priceMin' | 'priceMax' | 'requiresEvaluation'>,
): RenderResult {
  let text = template.replaceAll('{servicio}', service.name)

  if (text.includes('{precio}')) {
    const fixed =
      !service.requiresEvaluation &&
      service.priceMin !== null &&
      (service.priceMax === null ? false : service.priceMin === service.priceMax)
    if (!fixed || service.priceMin === null) {
      return {
        ok: false,
        reason: `"${service.name}" no tiene un precio fijo para poner en {precio}`,
      }
    }
    text = text.replaceAll('{precio}', String(service.priceMin))
  }

  const leftover = text.match(/\{[a-z_]+\}/)
  if (leftover) return { ok: false, reason: `marcador desconocido ${leftover[0]}` }
  return { ok: true, text }
}

/**
 * Si el nombre de imagen es seguro para leerlo de images/.
 *
 * Solo un nombre de archivo, sin carpetas: el valor viene del archivo del
 * negocio, pero se usa para armar una ruta en disco, y "../" no puede salir de
 * images/ nunca.
 */
export function isSafeImageName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|webp)$/.test(name)
}
