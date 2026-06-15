import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'
import { conversations } from './conversations.js'

export const events = pgTable(
  'events',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('events_business_id_idx').on(t.businessId),
    index('events_conversation_id_idx').on(t.conversationId),
    index('events_created_at_idx').on(t.createdAt),
  ],
)

export type Event = typeof events.$inferSelect
export type NewEvent = typeof events.$inferInsert
