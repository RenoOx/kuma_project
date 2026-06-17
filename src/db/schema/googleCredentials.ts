import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'

// One row per business. UNIQUE on business_id enforces the rule.
export const googleCredentials = pgTable('google_credentials', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => nanoid()),
  businessId: text('business_id')
    .notNull()
    .unique()
    .references(() => businesses.id, { onDelete: 'cascade' }),
  accessToken: text('access_token').notNull(),
  refreshToken: text('refresh_token').notNull(),
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }).notNull(),
  calendarId: text('calendar_id').notNull().default('primary'),
  connectedEmail: text('connected_email').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export type GoogleCredentials = typeof googleCredentials.$inferSelect
export type NewGoogleCredentials = typeof googleCredentials.$inferInsert
