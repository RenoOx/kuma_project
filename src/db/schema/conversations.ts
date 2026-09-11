import { index, pgTable, text, timestamp, varchar } from 'drizzle-orm/pg-core'
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

// How interested this lead looks, for the panel's inbox. A FOURTH axis, kept
// deliberately apart from the three that already exist:
//   - `type`    → who is on the other end (customer / owner)
//   - `status`  → whether the thread is open, closed or escalated
//   - `state`   → where the flow stands (stateMachine.ts owns it)
//   - `qualification` → how warm the lead is, for the human reading the inbox
// Collapsing any of these into another looked tempting and is wrong: a thread
// can be 'open' + 'await_payment' + 'human_takeover' all at once, and each
// answers a different question.
//
// Two writers, and the fixed rules win over the model: classify_interest can
// set 'qualified' / 'lost', but a booked appointment, an escalation or a human
// reply overwrite whatever the LLM said.
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
    qualification: text('qualification')
      .notNull()
      .default('new')
      .$type<ConversationQualification>(),
    // Set the moment the owner answers from the panel, cleared when the thread
    // goes back to Emma (manually or by the 30-minute timeout). Doubles as the
    // clock the auto-return worker reads, which is why it is a timestamp and
    // not a boolean.
    humanTakeoverAt: timestamp('human_takeover_at', { withTimezone: true }),
    // Set when the OWNER picks the label by hand from the panel. The existing
    // pin (LLM_PINNED_QUALIFICATIONS) protects by value — 'appointment' is a
    // fact whoever wrote it — and cannot tell a label Emma inferred from one a
    // person chose. This protects by origin: while it is set, neither
    // classify_interest nor the ageing worker may overwrite the row.
    //
    // A timestamp rather than a boolean for the same reason as the field above:
    // "when did they decide this" is the question anyone debugging a stuck
    // label will ask.
    qualificationLockedAt: timestamp('qualification_locked_at', { withTimezone: true }),
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
    // The inbox's default query: one business, filtered by qualification tab,
    // newest first.
    index('conversations_business_id_qualification_idx').on(t.businessId, t.qualification),
    // The auto-return worker scans only rows with a takeover clock running.
    index('conversations_human_takeover_at_idx').on(t.humanTakeoverAt),
  ],
)

export type Conversation = typeof conversations.$inferSelect
export type NewConversation = typeof conversations.$inferInsert
