import type { MiddlewareHandler } from 'hono'

// Qué puede cambiar el dueño desde el panel, y qué no.
//
// Editables: los datos del negocio, los servicios con sus precios y su material,
// los horarios y los días especiales. Además todo lo operativo: responder, pausar
// a Emma, etiquetas, citas.
//
// Solo lectura: TEXTO y LÓGICA de lo que decide cómo habla y vende Emma
// (identidad, mensajes, flujo, conversación, reservas y avisos, formas de pago
// y adelanto, base de conocimiento). Eso lo configura Vamvu en el repo
// (src/config/businesses/).
//
// Los ARCHIVOS son otro eje, y nunca se bloquean: ninguna foto vive en el repo,
// todas entran por panel+S3, sin excepción — el material de un paso de
// conversación y la galería de un mensaje fijo (`settings/fixed-messages/…`)
// se suben acá aunque el texto de ese mismo paso o mensaje esté bloqueado.
//
// Vale para TODOS los negocios, tengan archivo o no. El bloqueo vive en el
// servidor: ocultar el botón en el panel no alcanza, un PATCH armado a mano
// llegaría igual.

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// Se comparan contra la ruta completa. businessId es un segmento cualquiera: la
// autenticación ya corrió y resolvió el negocio antes de llegar acá.
const LOCKED_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/panel\/[^/]+\/settings\/(identity|messages|flow|conversation|booking|payments)\/?$/,
  /^\/api\/panel\/[^/]+\/knowledge(\/.*)?$/,
]

export const LOCKED_MESSAGE = 'Esto lo configura Vamvu. Escribinos si necesitás cambiarlo.'

/** Si el panel tiene cerrada esta escritura. Las lecturas nunca se cierran. */
export function isLockedPanelWrite(method: string, path: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return false
  return LOCKED_PATHS.some((pattern) => pattern.test(path))
}

/** Va después de panelAuth: al que no tiene token le sigue respondiendo 401. */
export const panelWriteLock: MiddlewareHandler = async (c, next) => {
  if (!isLockedPanelWrite(c.req.method, c.req.path)) return next()
  return c.json({ error: 'managed_by_vamvu', message: LOCKED_MESSAGE }, 403)
}
