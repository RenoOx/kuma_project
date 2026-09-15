import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'
import { conversations } from './conversations.js'

/**
 * Labels the owner invents for their own conversations.
 *
 * Replaces the `qualification` enum, which was a fixed set of seven values the
 * LLM and a worker assigned on their own. The owner knows their business well
 * enough to name what matters in it — "VIP", "Reclamo", "Debe seña" — and no
 * enum shipped from here was going to guess those.
 *
 * `color` holds a palette key, not a hex value: the panel renders it through
 * TAG_COLORS so every label is guaranteed to read against the dark background,
 * and changing a shade later is one edit rather than a data migration.
 */
export const tags = pgTable(
  'tags',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('tags_business_id_idx').on(t.businessId),
    // Two labels with the same name in one business are indistinguishable in
    // the inbox — the filter strip would show the same word twice.
    uniqueIndex('tags_business_id_name_uniq').on(t.businessId, t.name),
  ],
)

/**
 * Which labels are on which conversation.
 *
 * No `business_id` of its own: every row hangs off two rows that already carry
 * one, and every query reaches it through `conversations`, whose business_id is
 * the filter. Adding a third copy of the tenant here would be a third place for
 * it to disagree with the other two.
 */
export const conversationTags = pgTable(
  'conversation_tags',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conversation_tags_conversation_id_idx').on(t.conversationId),
    // Drives the "filter the inbox by this label" query.
    index('conversation_tags_tag_id_idx').on(t.tagId),
    uniqueIndex('conversation_tags_conversation_tag_uniq').on(t.conversationId, t.tagId),
  ],
)

export type Tag = typeof tags.$inferSelect
export type NewTag = typeof tags.$inferInsert
export type ConversationTag = typeof conversationTags.$inferSelect
export type NewConversationTag = typeof conversationTags.$inferInsert
