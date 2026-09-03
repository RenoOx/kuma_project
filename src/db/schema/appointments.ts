import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'
import { customers } from './customers.js'

// 'pending' is the entry point for businesses running bookingMode
// 'requires_approval': Emma files the request and a human promotes it. Plain
// text column, so widening this tuple needs no migration.
export const appointmentStatuses = [
  'pending',
  'scheduled',
  'confirmed',
  'cancelled',
  'completed',
] as const
export type AppointmentStatus = (typeof appointmentStatuses)[number]

export const appointments = pgTable(
  'appointments',
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
    service: text('service').notNull(),
    // The name the appointment was booked under, frozen at creation.
    //
    // customers.name answers "what is this person called today" and gets
    // overwritten every time someone gives Emma a new one — including when a
    // patient books for a relative. Reading a booking's name off that join made
    // past appointments silently change name, and left every booking the
    // deposit gate held back showing the WhatsApp push name.
    //
    // Nullable because rows predating this column have no snapshot, and an
    // owner-proposed slot legitimately has no name yet: readers fall back to
    // customers.name, so no backfill is needed.
    customerName: text('customer_name'),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    durationMinutes: integer('duration_minutes').notNull().default(30),
    status: text('status').notNull().default('scheduled').$type<AppointmentStatus>(),
    googleEventId: text('google_event_id'),
    notes: text('notes'),
    // Idempotency anchors for the reminders worker. NULL means "not yet sent";
    // a timestamp means "we already pushed that reminder, don't repeat".
    reminder24hSentAt: timestamp('reminder_24h_sent_at', { withTimezone: true }),
    reminder2hSentAt: timestamp('reminder_2h_sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('appointments_business_id_idx').on(t.businessId),
    index('appointments_customer_id_idx').on(t.customerId),
    index('appointments_scheduled_at_idx').on(t.scheduledAt),
    index('appointments_business_id_scheduled_at_idx').on(t.businessId, t.scheduledAt),
  ],
)

export type Appointment = typeof appointments.$inferSelect
export type NewAppointment = typeof appointments.$inferInsert
