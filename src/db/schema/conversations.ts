import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'
import { customers } from './customers.js'

export const conversationStatuses = ['open', 'closed', 'escalated'] as const
export type ConversationStatus = (typeof conversationStatuses)[number]

// 'customer'    → talk with a phone-side customer (the original V1 case)
// 'owner_thread' → talk with the business owner (rolling 48h memory)
// Modeled as a tuple-backed text column on purpose; adding 'admin' or other
// roles later is just appending to this list, no migration.
export const conversationTypes = ['customer', 'owner_thread'] as const
export type ConversationType = (typeof conversationTypes)[number]

export const conversations = pgTable(
  'conversations',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    // Nullable now because owner_thread conversations are not tied to a
    // customer record. Customer threads always set this.
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    type: text('type').notNull().default('customer').$type<ConversationType>(),
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
    index('conversations_business_id_type_idx').on(t.businessId, t.type),
  ],
)

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
