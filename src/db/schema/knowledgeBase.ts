import { boolean, index, jsonb, pgEnum, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'

export const kbCategoryEnum = pgEnum('kb_category', [
  'ubicacion',
  'servicios',
  'precios',
  'politicas',
  'contacto',
  'informacion_general',
])

export const kbAttachmentTypeEnum = pgEnum('kb_attachment_type', [
  'none',
  'link',
  'image',
  'pdf',
  'video',
])

export const kbSendModeEnum = pgEnum('kb_send_mode', ['always', 'on_request', 'trigger_based'])

export const knowledgeBase = pgTable(
  'knowledge_base',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    category: kbCategoryEnum('category').notNull(),
    content: text('content').notNull(),
    attachmentType: kbAttachmentTypeEnum('attachment_type').notNull().default('none'),
    attachmentUrl: text('attachment_url'),
    sendMode: kbSendModeEnum('send_mode').notNull().default('on_request'),
    // Only meaningful when sendMode = 'trigger_based'.
    triggerKeywords: text('trigger_keywords').array(),
    active: boolean('active').notNull().default(true),
    // Placeholder for the future RAG migration. Stored as jsonb (a plain number
    // array) so the schema needs no pgvector extension today. When semantic
    // search is switched on, this becomes a real `vector(1536)` column with an
    // HNSW index — see knowledgeBaseSearch.service.ts.
    embedding: jsonb('embedding'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('knowledge_base_business_id_idx').on(t.businessId),
    index('knowledge_base_business_category_idx').on(t.businessId, t.category),
  ],
)

export type KnowledgeBaseEntry = typeof knowledgeBase.$inferSelect
export type NewKnowledgeBaseEntry = typeof knowledgeBase.$inferInsert
export type KbCategory = (typeof kbCategoryEnum.enumValues)[number]
export type KbAttachmentType = (typeof kbAttachmentTypeEnum.enumValues)[number]
export type KbSendMode = (typeof kbSendModeEnum.enumValues)[number]
