import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { nanoid } from 'nanoid'
import { businesses } from './businesses.js'

/**
 * The files a service carries: photos, a price list, a voice note, a demo.
 *
 * Replaces `settings.services[].imageKey`, which held exactly one S3 key per
 * service and had no room for a type, a filename or an order. A service that
 * needs a photo AND a price sheet could not be expressed at all.
 *
 * `service_id` is TEXT and carries no foreign key, which is deliberate and is
 * the one compromise in this table: services are not rows. They live inside the
 * `businesses.settings` jsonb, each with a nanoid minted at its write boundary,
 * so there is nothing for a foreign key to point at. Integrity is the
 * application's job instead — see `purgeOrphans` in media.service, which runs
 * whenever the services list is saved and is what keeps a deleted service from
 * leaving files behind.
 *
 * `business_id` DOES have one, with cascade: it is the tenant boundary, every
 * query filters by it, and a deleted business must not leave rows pointing at a
 * bucket prefix nobody owns any more.
 *
 * What is stored is the KEY, never a URL. The bucket is private and links are
 * presigned on demand for an hour, so a stored URL would already have expired
 * by the time anyone opened it.
 */
export const serviceMedia = pgTable(
  'service_media',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => nanoid()),
    businessId: text('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /**
     * What owns this file: a service, or a step of the conversation flow.
     *
     * Defaulted to 'service' so every row that predates conversation-step media
     * reads correctly without a backfill. It is not cosmetic — `removeOrphans`
     * compares rows against the services list and deletes whatever is not named
     * there, so without this column the first save of the services list would
     * wipe every file belonging to a step.
     */
    ownerKind: text('owner_kind').notNull().default('service'),
    /**
     * The nanoid of whatever owns the file: a service inside
     * `businesses.settings.services`, or a node id inside
     * `settings.conversationFlow`. No FK — see above; neither one is a row.
     *
     * The column keeps its original name because renaming it is a destructive
     * migration for a distinction the `owner_kind` column already carries.
     */
    serviceId: text('service_id').notNull(),
    /** Full path inside the private bucket. Built by media.keys, never by a request. */
    s3Key: text('s3_key').notNull(),
    /** 'image' | 'pdf' | 'audio' | 'video'. Sniffed from the bytes, never from the upload. */
    type: text('type').notNull(),
    /** What the file was called when it was uploaded. Shown in the panel and sent as the document name. */
    filename: text('filename'),
    mimetype: text('mimetype').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    /** Ascending. Decides both the order in the panel and which files Emma sends first. */
    displayOrder: integer('display_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Every read is "the media of this owner, in this business, in order".
    index('service_media_business_service_idx').on(
      t.businessId,
      t.ownerKind,
      t.serviceId,
      t.displayOrder,
    ),
    // Used by the orphan sweep, which asks for every row of a business and
    // compares it against the services that still exist.
    index('service_media_business_id_idx').on(t.businessId),
  ],
)

export type ServiceMedia = typeof serviceMedia.$inferSelect
export type NewServiceMedia = typeof serviceMedia.$inferInsert
