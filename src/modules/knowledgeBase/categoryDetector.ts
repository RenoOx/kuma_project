import type { Niche } from '@/modules/business/business.settings.js'
import type { ActiveKbCategory } from './knowledgeBase.types.js'

// Deterministic keyword routing: given a customer message, guess which KB
// categories are relevant so the prompt loads a handful of entries instead of
// the whole table. Pure and synchronous on purpose — no extra LLM round trip
// before every reply, and trivially testable.
//
// Misses are cheap: the search service falls back to the oldest active entries
// when this returns nothing, so Emma is never left with an empty knowledge block
// just because the wording was unusual.
//
// Only routes the three active categories. Anything about services, prices,
// hours, address or contact details is answered from business settings, not
// from the knowledge base — see KB_CATEGORIES for why.
//
// Keywords are niche-aware for informacion_general: a dental patient asking
// "¿duele?" and a barbershop client asking "¿cuánto dura?" are both FAQ, but
// they share no vocabulary. politicas/promociones stay identical across niches —
// "aceptan tarjeta" or "tienen descuento" means the same thing everywhere.

const COMMON_KEYWORDS: Record<'politicas' | 'promociones', readonly string[]> = {
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
  // Inherited from the retired `precios` vocabulary: these words were always
  // about deals rather than the price list itself, and the price list now comes
  // from settings.
  promociones: [
    'promocion',
    'promociones',
    'promo',
    'promos',
    'oferta',
    'ofertas',
    'descuento',
    'descuentos',
    'campana',
    'combo',
    'combos',
    'paquete',
    'paquetes',
    '2x1',
  ],
}

// Shared base for the one specializable category. Every niche gets these PLUS
// its own vocabulary — specialization adds words, it never drops the generic
// ones.
const BASE_INFORMACION_GENERAL: readonly string[] = [
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
]

type SpecializableCategory = 'informacion_general'

// Niche-specific additions layered on top of the BASE_* list above. A niche that
// omits a category here just gets the base vocabulary for it.
const NICHE_KEYWORDS: Record<Niche, Partial<Record<SpecializableCategory, readonly string[]>>> = {
  barberia: {},
  estetica: {},
  dental: {
    informacion_general: [
      'dolor',
      'muela',
      'diente',
      'encia',
      'caries',
      'sangra',
      'hinchazon',
      'sensibilidad',
      'urgencia',
      'emergencia',
    ],
  },
  salud: {
    informacion_general: ['sintoma', 'dolor', 'malestar', 'ayuda', 'urgente', 'emergencia'],
  },
  general: {},
}

// Builds the full active-category keyword map for a niche: shared categories
// as-is, specializable ones as BASE + niche-specific additions.
function keywordsForNiche(niche: Niche): Record<ActiveKbCategory, readonly string[]> {
  const overrides = NICHE_KEYWORDS[niche]
  return {
    ...COMMON_KEYWORDS,
    informacion_general: [...BASE_INFORMACION_GENERAL, ...(overrides.informacion_general ?? [])],
  }
}

// Precomputed once per niche at module load — the lists are small and static,
// no reason to rebuild them on every detectCategories call.
const KEYWORDS_BY_NICHE: Record<Niche, Record<ActiveKbCategory, readonly string[]>> = {
  dental: keywordsForNiche('dental'),
  barberia: keywordsForNiche('barberia'),
  estetica: keywordsForNiche('estetica'),
  salud: keywordsForNiche('salud'),
  general: keywordsForNiche('general'),
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
//
// `niche` is required, not defaulted: every caller has a business in hand and
// should pass its actual niche (falling back to 'general' explicitly at the
// call site when the business is unconfigured), rather than this function
// silently guessing.
export function detectCategories(message: string, niche: Niche): ActiveKbCategory[] {
  const normalized = normalize(message)
  if (normalized.length === 0) return []

  const scored: Array<{ category: ActiveKbCategory; score: number }> = []
  for (const [category, keywords] of Object.entries(KEYWORDS_BY_NICHE[niche]) as Array<
    [ActiveKbCategory, readonly string[]]
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
export function matchesTriggerKeywords(message: string, triggerKeywords: string[] | null): boolean {
  if (!triggerKeywords || triggerKeywords.length === 0) return false
  const normalized = normalize(message)
  return triggerKeywords.some((kw) => {
    const normalizedKeyword = normalize(kw)
    return normalizedKeyword.length > 0 && containsKeyword(normalized, normalizedKeyword)
  })
}
