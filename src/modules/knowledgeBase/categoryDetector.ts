import type { KbCategory } from '@/db/schema/index.js'

// Deterministic keyword routing: given a customer message, guess which KB
// categories are relevant so the prompt loads a handful of entries instead of
// the whole table. Pure and synchronous on purpose — no extra LLM round trip
// before every reply, and trivially testable.
//
// Misses are cheap: the search service falls back to the oldest active entries
// when this returns nothing, so Emma is never left with an empty knowledge block
// just because the wording was unusual.

const KEYWORDS: Record<KbCategory, readonly string[]> = {
  ubicacion: [
    'donde',
    'ubicacion',
    'ubicados',
    'ubicado',
    'direccion',
    'llegar',
    'queda',
    'quedan',
    'local',
    'sucursal',
    'mapa',
    'maps',
    'referencia',
    'calle',
    'avenida',
    'distrito',
    'cerca',
    'estacionamiento',
    'parqueo',
    'como llego',
  ],
  servicios: [
    'servicio',
    'servicios',
    'hacen',
    'haces',
    'ofrecen',
    'trabajan',
    'atienden',
    'corte',
    'tratamiento',
    'portafolio',
    'catalogo',
    'fotos',
    'ejemplos',
    'modelos',
    'disenos',
    'trabajos',
  ],
  precios: [
    'precio',
    'precios',
    'cuesta',
    'cuestan',
    'cuanto',
    'vale',
    'valen',
    'tarifa',
    'tarifas',
    'costo',
    'promocion',
    'promociones',
    'promo',
    'oferta',
    'ofertas',
    'descuento',
    'combo',
    'combos',
    'paquete',
    'economico',
    'barato',
  ],
  politicas: [
    'politica',
    'politicas',
    'cancelar',
    'cancelacion',
    'anular',
    'reprogramar',
    'reembolso',
    'devolucion',
    'deposito',
    'adelanto',
    'garantia',
    'pago',
    'pagar',
    'pagos',
    'yape',
    'plin',
    'tarjeta',
    'efectivo',
    'transferencia',
    'factura',
    'boleta',
    'penalidad',
    'multa',
  ],
  contacto: [
    'contacto',
    'telefono',
    'numero',
    'celular',
    'llamar',
    'correo',
    'email',
    'instagram',
    'facebook',
    'tiktok',
    'redes',
    'web',
    'pagina',
    'whatsapp',
  ],
  informacion_general: [
    'quien',
    'quienes',
    'historia',
    'sobre ustedes',
    'sobre el negocio',
    'duena',
    'dueno',
    'propietaria',
    'propietario',
    'fundado',
    'experiencia',
    'anos',
    'confianza',
    'certificado',
    'certificacion',
  ],
}

// Strips accents and punctuation so "ubicación" and "ubicacion" both match, and
// so a keyword never fails on a trailing "?" or "!".
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// Word-boundary match so "vale" does not fire on "valentina" and "pago" does
// not fire on "pagoda".
function containsKeyword(haystack: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`).test(haystack)
}

// Returns the matching categories ordered by how many keywords each one hit,
// strongest first. Empty when nothing matches — the caller decides the fallback.
export function detectCategories(message: string): KbCategory[] {
  const normalized = normalize(message)
  if (normalized.length === 0) return []

  const scored: Array<{ category: KbCategory; score: number }> = []
  for (const [category, keywords] of Object.entries(KEYWORDS) as Array<
    [KbCategory, readonly string[]]
  >) {
    let score = 0
    for (const keyword of keywords) {
      if (containsKeyword(normalized, normalize(keyword))) score++
    }
    if (score > 0) scored.push({ category, score })
  }

  return scored.sort((a, b) => b.score - a.score).map((s) => s.category)
}

// Which `trigger_based` entries should fire for this message. Matching is done
// on the normalized message so keywords stored with accents still work.
export function matchesTriggerKeywords(
  message: string,
  triggerKeywords: string[] | null,
): boolean {
  if (!triggerKeywords || triggerKeywords.length === 0) return false
  const normalized = normalize(message)
  return triggerKeywords.some((kw) => {
    const normalizedKeyword = normalize(kw)
    return normalizedKeyword.length > 0 && containsKeyword(normalized, normalizedKeyword)
  })
}
