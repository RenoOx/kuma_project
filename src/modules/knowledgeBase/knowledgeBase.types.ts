import { z } from 'zod'
import {
  type KbAttachmentType,
  type KbCategory,
  type KbSendMode,
  kbAttachmentTypeEnum,
  kbSendModeEnum,
} from '@/db/schema/index.js'

// Single source of truth for every KB enum. The admin API, the dashboard forms,
// the CLI and the demo profiles all validate through here.

// The knowledge base only covers what business settings cannot. Services,
// prices, opening hours, address and contact details live in
// `businesses.settings` as structured data, and a KB entry repeating them was a
// second source of truth Emma could read and contradict herself with. Those four
// categories are retired: no new entry can be filed under them.
//
// NOT derived from the pg enum anymore. The enum still carries the retired
// values because rows written before the retirement still reference them —
// dropping an enum value would break reading those rows. This list is the
// active set, and it is what the forms, the validation schema and the category
// detector all work from.
export const KB_CATEGORIES = ['politicas', 'informacion_general', 'promociones'] as const

// Retired categories. Kept only so queries can filter their rows out of Emma's
// prompt; nothing writes them. See LEGACY_KB_CATEGORY_LABELS below.
export const LEGACY_KB_CATEGORIES = ['ubicacion', 'servicios', 'precios', 'contacto'] as const

export const KB_ATTACHMENT_TYPES = kbAttachmentTypeEnum.enumValues
export const KB_SEND_MODES = kbSendModeEnum.enumValues

export const kbCategorySchema = z.enum(KB_CATEGORIES)
export const kbAttachmentTypeSchema = z.enum(KB_ATTACHMENT_TYPES)
export const kbSendModeSchema = z.enum(KB_SEND_MODES)

export type { KbAttachmentType, KbCategory, KbSendMode }

// A category a new entry may actually use. `KbCategory` stays the full column
// union (drizzle infers it from the pg enum, retired values included), so code
// reading a stored row keeps type-checking; this is the narrower write-side type.
export type ActiveKbCategory = (typeof KB_CATEGORIES)[number]

// Human labels for the dashboard and the CLI. Spanish, since that is what the
// business owner reads. Covers the retired categories too: a legacy row still
// has to render as something readable wherever one slips through.
export const KB_CATEGORY_LABELS: Record<KbCategory, string> = {
  politicas: 'Políticas',
  informacion_general: 'Preguntas frecuentes',
  promociones: 'Promociones',
  ubicacion: 'Ubicación',
  servicios: 'Servicios',
  precios: 'Precios',
  contacto: 'Contacto',
}

export const KB_SEND_MODE_LABELS: Record<KbSendMode, string> = {
  always: 'Siempre',
  on_request: 'Bajo pedido',
  trigger_based: 'Por palabras clave',
}

export const KB_ATTACHMENT_TYPE_LABELS: Record<KbAttachmentType, string> = {
  none: 'Sin adjunto',
  link: 'Enlace',
  image: 'Imagen',
  pdf: 'PDF',
  video: 'Video',
}

// Title is auto-derived from the content when the caller does not supply one.
export const KB_TITLE_MAX_LENGTH = 50

export function deriveTitle(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim()
  return flat.length <= KB_TITLE_MAX_LENGTH ? flat : flat.slice(0, KB_TITLE_MAX_LENGTH).trimEnd()
}

// ── Write-side request schemas ───────────────────────────────────────────────
//
// Shared by the admin API and the owner's panel. They live here rather than
// next to either set of routes because both write the same table under the same
// rules: a second copy would be a second place for the attachment and keyword
// rules to drift.

// An attachment type other than 'none' is meaningless without a URL, and a URL
// is meaningless without a type. Rejected up front rather than stored half-set.
function hasCoherentAttachment(v: {
  attachmentType?: KbAttachmentType
  attachmentUrl?: string | null
}): boolean {
  if (v.attachmentType === undefined) return true
  return v.attachmentType === 'none' ? !v.attachmentUrl : Boolean(v.attachmentUrl)
}

const attachmentRefinement = {
  message:
    'attachmentUrl is required when attachmentType is not "none", and must be omitted when it is',
  path: ['attachmentUrl'],
}

const triggerKeywordsRefinement = {
  message: 'triggerKeywords is required when sendMode is "trigger_based"',
  path: ['triggerKeywords'],
}

function hasKeywordsWhenTriggerBased(v: {
  sendMode?: KbSendMode
  triggerKeywords?: string[] | null
}): boolean {
  return v.sendMode !== 'trigger_based' || (v.triggerKeywords?.length ?? 0) > 0
}

const kbFields = {
  title: z.string().min(1).max(120).optional(),
  content: z.string().min(1),
  category: kbCategorySchema,
  attachmentType: kbAttachmentTypeSchema.optional(),
  attachmentUrl: z.string().url().nullable().optional(),
  sendMode: kbSendModeSchema.optional(),
  triggerKeywords: z.array(z.string().min(1)).nullable().optional(),
  active: z.boolean().optional(),
}

export const createKbBodySchema = z
  .object(kbFields)
  .refine(hasCoherentAttachment, attachmentRefinement)
  .refine(hasKeywordsWhenTriggerBased, triggerKeywordsRefinement)

export const patchKbBodySchema = z
  .object({
    ...kbFields,
    content: kbFields.content.optional(),
    category: kbFields.category.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'body must have at least one field' })
  .refine(hasCoherentAttachment, attachmentRefinement)
  .refine(hasKeywordsWhenTriggerBased, triggerKeywordsRefinement)

export type CreateKbBody = z.infer<typeof createKbBodySchema>
export type PatchKbBody = z.infer<typeof patchKbBodySchema>
