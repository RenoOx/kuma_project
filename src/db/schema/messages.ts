import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'
import { conversations } from './conversations.js'

export const messageRoles = ['user', 'assistant', 'tool', 'system'] as const
export type MessageRole = (typeof messageRoles)[number]

// Who actually produced this message, for the panel's chat bubbles.
//
// COMPLEMENTS `role`, it does not replace it. `role` is the OpenAI vocabulary
// and is what gets replayed into the model — an owner's reply from the panel is
// still an 'assistant' turn as far as the conversation history is concerned, or
// Emma would lose the thread. `sender_type` answers the question `role` cannot:
// was that assistant turn written by Emma or typed by a human?
//
// Default 'bot' matches every row that predates this column: before the panel
// existed, no human could write into a conversation.
export const messageSenderTypes = ['customer', 'bot', 'human'] as const
export type MessageSenderType = (typeof messageSenderTypes)[number]

/**
 * Un archivo que viajó con este mensaje: la foto que mandó el cliente o lo que
 * mandó Emma (galería de un mensaje fijo, material de un paso, ficha de un
 * servicio). Solo la key: el bucket es privado y el panel firma el link al leer.
 * Existe para que el chat del panel muestre lo mismo que el celular (2026-11-09).
 */
export interface MessageAttachment {
  s3Key: string
  type: 'image' | 'pdf' | 'audio' | 'video'
}

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
    senderType: text('sender_type').notNull().default('bot').$type<MessageSenderType>(),
    content: text('content').notNull(),
    toolCalls: jsonb('tool_calls'),
    toolCallId: text('tool_call_id'),
    // Null en todo lo anterior al 2026-11-09 y en lo que no lleva archivos.
    attachments: jsonb('attachments').$type<MessageAttachment[]>(),
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
