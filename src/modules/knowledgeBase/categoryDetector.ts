import type { KbCategory } from '@/db/schema/index.js'
import type { Niche } from '@/modules/business/business.settings.js'

// Deterministic keyword routing: given a customer message, guess which KB
// categories are relevant so the prompt loads a handful of entries instead of
// the whole table. Pure and synchronous on purpose — no extra LLM round trip
// before every reply, and trivially testable.
//
// Misses are cheap: the search service falls back to the oldest active entries
// when this returns nothing, so Emma is never left with an empty knowledge block
// just because the wording was unusual.
//
// Keywords are niche-aware for servicios/precios/informacion_general — a
// dental clinic and a barbershop don't share a vocabulary for what they sell.
// ubicacion/politicas/contacto stay identical across niches: "dónde quedan" or
// "aceptan tarjeta" means the same thing regardless of business type.

const COMMON_KEYWORDS: Record<'ubicacion' | 'politicas' | 'contacto', readonly string[]> = {
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
}

// Shared base for the three specializable categories. Every niche gets these
// PLUS its own vocabulary — specialization adds words, it never drops the
// generic ones. A dental patient still says "ofrecen" and "cuesta" same as
// anyone else; only the noun changes ("muela" vs "corte").
const BASE_SERVICIOS: readonly string[] = [
  'servicio',
  'servicios',
  'hacen',
  'haces',
  'ofrecen',
  'trabajan',
  'atienden',
  'tratamiento',
  'portafolio',
  'catalogo',
  'fotos',
  'ejemplos',
  'modelos',
  'disenos',
  'trabajos',
]

const BASE_PRECIOS: readonly string[] = [
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
]

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

type SpecializableCategory = 'servicios' | 'precios' | 'informacion_general'

// Niche-specific additions layered on top of the BASE_* lists above. A niche
// that omits a category here just gets the base vocabulary for it.
const NICHE_KEYWORDS: Record<Niche, Partial<Record<SpecializableCategory, readonly string[]>>> = {
  barberia: {
    servicios: ['corte', 'barba', 'tinte', 'alisado', 'keratina', 'trenza', 'rasura', 'fade', 'degradado'],
    precios: ['cobran'],
  },
  estetica: {
    servicios: [
      'unas',
      'pestanas',
      'cejas',
      'facial',
      'limpieza facial',
      'masaje',
      'depilacion',
      'maquillaje',
      'peeling',
      'microblading',
      'manicure',
      'pedicure',
    ],
    precios: ['cobran'],
  },
  dental: {
    servicios: [
      'limpieza',
      'blanqueamiento',
      'extraccion',
      'curacion',
      'ortodoncia',
      'brackets',
      'implante',
      'corona',
      'puente',
      'endodoncia',
      'radiografia',
      'profilaxis',
      'resina',
      'carilla',
      'protesis',
    ],
    precios: ['cobran', 'cobertura', 'seguro', 'presupuesto'],
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
    servicios: ['consulta', 'sesion', 'terapia', 'evaluacion', 'control', 'cita', 'diagnostico'],
    precios: ['cobran', 'cobertura', 'seguro'],
    informacion_general: ['sintoma', 'dolor', 'malestar', 'ayuda', 'urgente', 'emergencia'],
  },
  general: {
    servicios: ['atencion', 'sesion', 'consulta'],
    precios: ['cobran'],
  },
}

// Builds the full 6-category keyword map for a niche: shared categories as-is,
// specializable ones as BASE + niche-specific additions.
function keywordsForNiche(niche: Niche): Record<KbCategory, readonly string[]> {
  const overrides = NICHE_KEYWORDS[niche]
  return {
    ...COMMON_KEYWORDS,
    servicios: [...BASE_SERVICIOS, ...(overrides.servicios ?? [])],
    precios: [...BASE_PRECIOS, ...(overrides.precios ?? [])],
    informacion_general: [...BASE_INFORMACION_GENERAL, ...(overrides.informacion_general ?? [])],
  }
}

// Precomputed once per niche at module load — the lists are small and static,
// no reason to rebuild them on every detectCategories call.
const KEYWORDS_BY_NICHE: Record<Niche, Record<KbCategory, readonly string[]>> = {
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
export function detectCategories(message: string, niche: Niche): KbCategory[] {
  const normalized = normalize(message)
  if (normalized.length === 0) return []

  const scored: Array<{ category: KbCategory; score: number }> = []
  for (const [category, keywords] of Object.entries(KEYWORDS_BY_NICHE[niche]) as Array<
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
