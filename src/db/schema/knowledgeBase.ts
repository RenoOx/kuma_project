import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'

export const knowledgeBase = pgTable(
  'knowledge_base',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    content: text('content').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('knowledge_base_business_id_idx').on(t.businessId)],
)

export type KnowledgeBaseEntry = typeof knowledgeBase.$inferSelect
export type NewKnowledgeBaseEntry = typeof knowledgeBase.$inferInsert
