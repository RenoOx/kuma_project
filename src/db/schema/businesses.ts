import { sql } from 'drizzle-orm'
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'

export const businesses = pgTable(
  'businesses',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    name: text('name').notNull(),
    whatsappNumber: text('whatsapp_number').notNull().unique(),
    timezone: text('timezone').notNull().default('America/Lima'),
    systemPrompt: text('system_prompt'),
    settings: jsonb('settings').notNull().default(sql`'{}'::jsonb`),
    // Owner contact: when an incoming WA message comes from this phone we
    // route to the ownerAssistant flow instead of the customer one. Nullable
    // because not every business has linked an owner yet.
    ownerWhatsappNumber: text('owner_whatsapp_number'),
    ownerName: text('owner_name'),
    // Street address. Structured rather than left to the knowledge base so Emma
    // can answer "where are you?" without depending on someone having written
    // it into a KB entry. googleMapsUrl complements it, it does not replace it.
    address: text('address'),
    googleMapsUrl: text('google_maps_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('businesses_owner_whatsapp_number_idx').on(t.ownerWhatsappNumber)],
)

export type Business = typeof businesses.$inferSelect
export type NewBusiness = typeof businesses.$inferInsert
