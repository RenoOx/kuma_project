import { boolean, index, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
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

// RETIRED. Nothing reads or writes this any more — the owner's own tags (see
// db/schema/tags.ts) replaced it, because a fixed set of seven labels decided by
// the model was never going to describe somebody else's business.
//
// The tuple and both columns stay declared ONLY so drizzle-kit does not emit a
// DROP on the next generate. Dropping them is its own migration, run once
// production has spent a while not needing them.
//
// The three axes that remain:
//   - `type`    → who is on the other end (customer / owner)
//   - `status`  → whether the thread is open, closed or escalated
//   - `state`   → where the flow stands (stateMachine.ts owns it)
// Plus two facts that used to be folded into the qualification and are now read
// directly: `humanTakeoverAt` (a person is holding this thread) and
// `emmaEnabled` (the owner switched Emma off here).
export const conversationQualifications = [
  'new',
  'qualified',
  'needs_info',
  'appointment',
  'waiting',
  'lost',
  'human_takeover',
] as const
export type ConversationQualification = (typeof conversationQualifications)[number]

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
    state: varchar('state', { length: 50 }).notNull().default('idle'),
    /** @deprecated Retired — see the note above. Kept so generate emits no DROP. */
    qualification: text('qualification')
      .notNull()
      .default('new')
      .$type<ConversationQualification>(),
    // Set the moment the owner answers from the panel, cleared when the thread
    // goes back to Emma (manually or by the 30-minute timeout). Doubles as the
    // clock the auto-return worker reads, which is why it is a timestamp and
    // not a boolean.
    humanTakeoverAt: timestamp('human_takeover_at', { withTimezone: true }),
    /** @deprecated Retired with `qualification`. Kept so generate emits no DROP. */
    qualificationLockedAt: timestamp('qualification_locked_at', { withTimezone: true }),
    // The owner's per-chat switch for Emma. Distinct from humanTakeoverAt,
    // which is temporary and clears itself after 30 minutes: this one is a
    // deliberate "I am handling this thread myself" and stays until switched
    // back. Nothing clears it automatically — not the takeover worker, not
    // "Devolver a Emma".
    emmaEnabled: boolean('emma_enabled').notNull().default(true),
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
    // Retired with the column. Kept so generate emits no DROP INDEX.
    index('conversations_business_id_qualification_idx').on(t.businessId, t.qualification),
    // The auto-return worker scans only rows with a takeover clock running.
    index('conversations_human_takeover_at_idx').on(t.humanTakeoverAt),
  ],
)

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
