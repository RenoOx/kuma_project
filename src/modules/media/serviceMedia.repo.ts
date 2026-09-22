import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
import { db, type Executor } from '@/db/client.js'
import { type NewServiceMedia, type ServiceMedia, serviceMedia } from '@/db/schema/index.js'
import type { MediaOwnerKind } from './media.types.js'

/**
 * Rows only. Every S3 object these rows point at is deleted by the service
 * layer, which is the only place that can order the two correctly.
 *
 * Every function takes `businessId` and filters by it, including the ones that
 * already have a primary key. A row id is enough to find a row but not enough to
 * be allowed to touch it.
 *
 * Every function that reads or deletes BY OWNER also takes `ownerKind`, and that
 * is not optional for a reason: services and conversation steps share this table
 * and their ids are both nanoids, so a query that filters only on the id would
 * happily return — or delete — the other kind's rows.
 */

export async function insert(data: NewServiceMedia, exec: Executor = db): Promise<ServiceMedia> {
  const [row] = await exec.insert(serviceMedia).values(data).returning()
  if (!row) throw new Error('insert service_media returned no row')
  return row
}

export async function findById(
  businessId: string,
  id: string,
  exec: Executor = db,
): Promise<ServiceMedia | null> {
  const [row] = await exec
    .select()
    .from(serviceMedia)
    .where(and(eq(serviceMedia.businessId, businessId), eq(serviceMedia.id, id)))
    .limit(1)
  return row ?? null
}

export async function listByOwner(
  businessId: string,
  ownerKind: MediaOwnerKind,
  ownerId: string,
  exec: Executor = db,
): Promise<ServiceMedia[]> {
  return exec
    .select()
    .from(serviceMedia)
    .where(
      and(
        eq(serviceMedia.businessId, businessId),
        eq(serviceMedia.ownerKind, ownerKind),
        eq(serviceMedia.serviceId, ownerId),
      ),
    )
    .orderBy(asc(serviceMedia.displayOrder), asc(serviceMedia.createdAt))
}

/** Every file in the business, for the panel's per-owner counts and the orphan sweep. */
export async function listByBusiness(
  businessId: string,
  ownerKind: MediaOwnerKind | null = null,
  exec: Executor = db,
): Promise<ServiceMedia[]> {
  const where =
    ownerKind === null
      ? eq(serviceMedia.businessId, businessId)
      : and(eq(serviceMedia.businessId, businessId), eq(serviceMedia.ownerKind, ownerKind))
  return exec
    .select()
    .from(serviceMedia)
    .where(where)
    .orderBy(asc(serviceMedia.serviceId), asc(serviceMedia.displayOrder))
}

/** The media of several owners at once, so listing a catalogue is one query. */
export async function listByOwners(
  businessId: string,
  ownerKind: MediaOwnerKind,
  ownerIds: string[],
  exec: Executor = db,
): Promise<ServiceMedia[]> {
  if (ownerIds.length === 0) return []
  return exec
    .select()
    .from(serviceMedia)
    .where(
      and(
        eq(serviceMedia.businessId, businessId),
        eq(serviceMedia.ownerKind, ownerKind),
        inArray(serviceMedia.serviceId, ownerIds),
      ),
    )
    .orderBy(asc(serviceMedia.serviceId), asc(serviceMedia.displayOrder))
}

/** Returns the deleted row so the caller knows which object to drop from the bucket. */
export async function remove(
  businessId: string,
  id: string,
  exec: Executor = db,
): Promise<ServiceMedia | null> {
  const [row] = await exec
    .delete(serviceMedia)
    .where(and(eq(serviceMedia.businessId, businessId), eq(serviceMedia.id, id)))
    .returning()
  return row ?? null
}

/** Everything one owner owns. Returns the rows, for the same reason. */
export async function removeByOwner(
  businessId: string,
  ownerKind: MediaOwnerKind,
  ownerId: string,
  exec: Executor = db,
): Promise<ServiceMedia[]> {
  return exec
    .delete(serviceMedia)
    .where(
      and(
        eq(serviceMedia.businessId, businessId),
        eq(serviceMedia.ownerKind, ownerKind),
        eq(serviceMedia.serviceId, ownerId),
      ),
    )
    .returning()
}

/**
 * Everything belonging to a service that no longer exists.
 *
 * The sweep that keeps a deleted service from leaving files behind. It runs on
 * the services list as a whole rather than on a delete event, because services
 * are saved as a replaced array — nothing ever says "this one was removed", it
 * simply stops being there. Comparing what the bucket has against what the list
 * still names is the only way to notice.
 *
 * An empty `keepIds` means the owner kind has nothing left, so everything of
 * that kind goes. Written as its own branch because `notInArray(x, [])` is not
 * reliably true across drivers, and getting it wrong here would delete nothing
 * when it should delete everything, or the reverse.
 *
 * SCOPED BY `ownerKind`, and that is the whole point of the column. Before it
 * existed this deleted every row of the business whose id was not in the
 * services list — which, once conversation steps started storing files here,
 * would have wiped all of them on the first save of the services list.
 */
export async function removeOrphans(
  businessId: string,
  ownerKind: MediaOwnerKind,
  keepIds: string[],
  exec: Executor = db,
): Promise<ServiceMedia[]> {
  const scope = and(eq(serviceMedia.businessId, businessId), eq(serviceMedia.ownerKind, ownerKind))
  const where =
    keepIds.length === 0 ? scope : and(scope, notInArray(serviceMedia.serviceId, keepIds))

  return exec.delete(serviceMedia).where(where).returning()
}

export async function setDisplayOrder(
  businessId: string,
  id: string,
  displayOrder: number,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(serviceMedia)
    .set({ displayOrder, updatedAt: new Date() })
    .where(and(eq(serviceMedia.businessId, businessId), eq(serviceMedia.id, id)))
}
