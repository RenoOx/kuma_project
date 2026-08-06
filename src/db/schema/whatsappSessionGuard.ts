import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'

// Rate-limit state for WhatsApp linking, keyed by PHONE NUMBER — not by
// business. WhatsApp throttles and bans the number itself, so the guard has to
// follow the number: if a business swaps to a fresh number it must start with a
// clean slate, and if it swaps back to an old one it must inherit that number's
// history.
//
// businessId is informational (last business that used this number) and is
// nullable on purpose: deleting a business must NOT drop the number's cooldown,
// because WhatsApp keeps throttling it regardless of our DB.
export const whatsappSessionGuard = pgTable('whatsapp_session_guard', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => nanoid()),
  whatsappNumber: text('whatsapp_number').notNull().unique(),
  businessId: text('business_id').references(() => businesses.id, { onDelete: 'set null' }),
  // Last time we asked WhatsApp for a pairing code / booted a fresh socket.
  // Each of these is a request WhatsApp counts against the number.
  lastPairingCodeAt: timestamp('last_pairing_code_at', { withTimezone: true }),
  lastRestartAt: timestamp('last_restart_at', { withTimezone: true }),
  // Rolling window used by the circuit breaker.
  attemptCount: integer('attempt_count').notNull().default(0),
  attemptWindowStartedAt: timestamp('attempt_window_started_at', { withTimezone: true }),
  // Set when the circuit breaker trips or WhatsApp hands us a fatal disconnect.
  // While in the future, nothing may touch this number without an explicit
  // operator override.
  blockedUntil: timestamp('blocked_until', { withTimezone: true }),
  haltReason: text('halt_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type WhatsappSessionGuard = typeof whatsappSessionGuard.$inferSelect
export type NewWhatsappSessionGuard = typeof whatsappSessionGuard.$inferInsert
