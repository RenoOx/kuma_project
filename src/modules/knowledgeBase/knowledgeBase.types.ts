import {
  kbAttachmentTypeEnum,
  kbCategoryEnum,
  kbSendModeEnum,
  type KbAttachmentType,
  type KbCategory,
  type KbSendMode,
} from '@/db/schema/index.js'
import { z } from 'zod'

// Single source of truth for every KB enum. The admin API, the dashboard forms,
// the CLI and the demo profiles all validate through here so a new category is
// added in exactly one place (the drizzle enum) and picked up everywhere.

export const KB_CATEGORIES = kbCategoryEnum.enumValues
export const KB_ATTACHMENT_TYPES = kbAttachmentTypeEnum.enumValues
export const KB_SEND_MODES = kbSendModeEnum.enumValues

export const kbCategorySchema = z.enum(KB_CATEGORIES)
export const kbAttachmentTypeSchema = z.enum(KB_ATTACHMENT_TYPES)
export const kbSendModeSchema = z.enum(KB_SEND_MODES)

export type { KbAttachmentType, KbCategory, KbSendMode }

// Human labels for the dashboard and the CLI. Spanish, since that is what the
// business owner reads.
export const KB_CATEGORY_LABELS: Record<KbCategory, string> = {
  ubicacion: 'Ubicación',
  servicios: 'Servicios',
  precios: 'Precios',
  politicas: 'Políticas',
  contacto: 'Contacto',
  informacion_general: 'Información general',
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
