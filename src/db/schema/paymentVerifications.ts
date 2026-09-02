import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { appointments } from './appointments.js'
import { businesses } from './businesses.js'
import { conversations } from './conversations.js'
import { customers } from './customers.js'

// A payment capture waiting on the owner's eyes.
//
// Under `requiresDeposit`, the booking the customer is paying for does not
// exist yet — the deposit gate is holding it — and the intent behind it
// (service, slot, name) lived ONLY in the in-memory expectation map, consumed
// the moment the photo landed. That was enough while the capture booked the
// appointment on arrival, because the two happened milliseconds apart.
//
// It stops being enough once the owner is the one who decides: they may answer
// in an hour, or after a deploy. So the frozen intent is persisted here, and
// this row — not the memory map — is what the approval books from.
//
// 'superseded' is what a still-open row becomes when the customer sends a
// second capture before the owner ruled on the first: only one verification per
// conversation is ever open, and closing the old one by status keeps the
// history of what arrived.
export const paymentVerificationStatuses = [
  'pending',
  'approved',
  'rejected',
  'superseded',
] as const
export type PaymentVerificationStatus = (typeof paymentVerificationStatuses)[number]

export const paymentVerifications = pgTable(
  'payment_verifications',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    // The frozen booking intent, exactly the fields PaymentContext carries.
    service: text('service').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    // Free text, mirroring settings.depositAmount ("S/ 20", "el 50%").
    depositAmount: text('deposit_amount'),
    // The name the customer gave Emma, not the WhatsApp push name: the rename
    // inside bookAppointment has not run yet when this row is written.
    customerName: text('customer_name').notNull(),
    status: text('status').notNull().default('pending').$type<PaymentVerificationStatus>(),
    // Set on approval, so a row can be traced to what it produced.
    appointmentId: text('appointment_id').references(() => appointments.id, {
      onDelete: 'set null',
    }),
    // Free-text note from the owner when they turn a capture down.
    rejectionReason: text('rejection_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [
    index('payment_verifications_business_id_idx').on(t.businessId),
    index('payment_verifications_business_id_conversation_id_idx').on(
      t.businessId,
      t.conversationId,
    ),
  ],
)

export type PaymentVerification = typeof paymentVerifications.$inferSelect
export type NewPaymentVerification = typeof paymentVerifications.$inferInsert
