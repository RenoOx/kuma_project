import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'

export const customers = pgTable(
  'customers',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    phone: text('phone').notNull(),
    name: text('name'),
    /**
     * Everything the business learned about this customer that is not a column.
     *
     * Today it holds one key, `collected`: the answers the collect-data step
     * gathered, as the owner named the fields. Before this, every field but the
     * name was acknowledged and dropped — it survived only in the transcript, so
     * nothing could branch on "this student already has the prerequisite".
     *
     * Free-form because the fields are: `settings.collectDataFields` is written
     * by the owner in their own words, and giving each one a column would mean a
     * migration every time a business added a question.
     */
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
    // The transport address WhatsApp actually routes by, captured from the last
    // inbound message or call. `phone` is a business fact and cannot be turned
    // back into a JID: since the LID migration a new contact arrives as
    // "<lid>@lid" with no phone exposed, and the "<phone>@s.whatsapp.net" we
    // used to rebuild does not exist for them. Null on rows created before this
    // column, which fall back to the rebuilt JID exactly as before.
    waJid: text('wa_jid'),
    // Set when WhatsApp told us this JID has no account behind it. Proactive
    // sends skip a flagged customer instead of retrying every poll — repeatedly
    // messaging numbers that do not exist is a spam signal. Cleared the moment
    // the customer writes again (see customer.repo.updateLastSeen).
    whatsappUnreachableAt: timestamp('whatsapp_unreachable_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('customers_business_id_idx').on(t.businessId),
    uniqueIndex('customers_business_id_phone_uniq').on(t.businessId, t.phone),
  ],
)

export type Customer = typeof customers.$inferSelect
export type NewCustomer = typeof customers.$inferInsert
