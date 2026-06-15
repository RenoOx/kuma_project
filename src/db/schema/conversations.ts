import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'
import { customers } from './customers.js'

export const conversationStatuses = ['open', 'closed', 'escalated'] as const
export type ConversationStatus = (typeof conversationStatuses)[number]

export const conversations = pgTable(
  'conversations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('open').$type<ConversationStatus>(),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('conversations_business_id_idx').on(t.businessId),
    index('conversations_customer_id_idx').on(t.customerId),
    index('conversations_last_message_at_idx').on(t.lastMessageAt),
    index('conversations_business_id_status_idx').on(t.businessId, t.status),
  ],
)

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
