import { z } from 'zod'

/**
 * The palette a label's colour must come from.
 *
 * A closed set rather than a free colour, because the panel renders on a near
 * black ground: an owner who picks their brand's yellow gets a pill nobody can
 * read, and they find out after labelling forty conversations with it. These
 * ten are checked against that background.
 *
 * Stored as the key, not the hex. The panel maps key → colour, so restyling the
 * palette later is one edit instead of a data migration.
 */
export const TAG_COLORS = [
  'emerald',
  'blue',
  'violet',
  'rose',
  'amber',
  'cyan',
  'pink',
  'indigo',
  'orange',
  'teal',
] as const

export type TagColor = (typeof TAG_COLORS)[number]

/**
 * How many labels one business may have.
 *
 * Not a storage limit — it is a usability one. The inbox shows the labels as a
 * filter strip, and past ten the strip stops being something you scan and
 * becomes something you search.
 */
export const MAX_TAGS_PER_BUSINESS = 10

export const tagColorSchema = z.enum(TAG_COLORS)

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(30),
  color: tagColorSchema,
})

export const updateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(30),
    color: tagColorSchema,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'body must have at least one field' })

export const assignTagsSchema = z.object({
  // The complete set, not a delta. An empty array clears every label.
  tagIds: z.array(z.string().min(1)).max(MAX_TAGS_PER_BUSINESS),
})

export type CreateTagInput = z.infer<typeof createTagSchema>
export type UpdateTagInput = z.infer<typeof updateTagSchema>
export type AssignTagsInput = z.infer<typeof assignTagsSchema>

/**
 * Las tres etiquetas de calificación de un lead, las únicas que pone el código.
 *
 * "Por validar" la pone el handler cuando Emma se pausa porque el cliente mandó
 * la captura o el DNI (`onImage.pause`); "Pagó" / "No pagó" las pone el dueño
 * con los botones del chat en el panel. Se crean solas la primera vez que hacen
 * falta, y se buscan por NOMBRE: si el dueño renombra una, la próxima vez se
 * crea de nuevo con este nombre. El panel tiene una copia de los nombres en
 * `panel/lib/constants.ts`.
 */
export const QUALIFICATION_TAGS = {
  pending: { name: 'Por validar', color: 'amber' },
  paid: { name: 'Pagó', color: 'emerald' },
  not_paid: { name: 'No pagó', color: 'rose' },
} as const satisfies Record<string, { name: string; color: TagColor }>

export const qualifySchema = z.object({ outcome: z.enum(['paid', 'not_paid']) })

export type QualificationOutcome = z.infer<typeof qualifySchema>['outcome']
