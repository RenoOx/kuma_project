import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'
import { conversations } from './conversations.js'

export const messageRoles = ['user', 'assistant', 'tool', 'system'] as const
export type MessageRole = (typeof messageRoles)[number]

export const messages = pgTable(
  'messages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    role: text('role').notNull().$type<MessageRole>(),
    content: text('content').notNull(),
    toolCalls: jsonb('tool_calls'),
    toolCallId: text('tool_call_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_conversation_id_idx').on(t.conversationId),
    index('messages_business_id_idx').on(t.businessId),
    index('messages_created_at_idx').on(t.createdAt),
    index('messages_conversation_id_created_at_idx').on(t.conversationId, t.createdAt),
  ],
)

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
