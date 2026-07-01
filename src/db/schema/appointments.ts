import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'
import { customers } from './customers.js'

export const appointmentStatuses = ['scheduled', 'confirmed', 'cancelled', 'completed'] as const
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
