import { and, asc, eq, inArray, notInArray } from 'drizzle-orm'
import { db, type Executor } from '@/db/client.js'
import { type NewServiceMedia, type ServiceMedia, serviceMedia } from '@/db/schema/index.js'

/**
 * Rows only. Every S3 object these rows point at is deleted by the service
 * layer, which is the only place that can order the two correctly.
 *
 * Every function takes `businessId` and filters by it, including the ones that
 * already have a primary key. A row id is enough to find a row but not enough to
 * be allowed to touch it.
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

export async function listByService(
  businessId: string,
  serviceId: string,
  exec: Executor = db,
): Promise<ServiceMedia[]> {
  return exec
    .select()
    .from(serviceMedia)
    .where(and(eq(serviceMedia.businessId, businessId), eq(serviceMedia.serviceId, serviceId)))
    .orderBy(asc(serviceMedia.displayOrder), asc(serviceMedia.createdAt))
}

/** Every file in the business, for the panel's per-service counts and the orphan sweep. */
export async function listByBusiness(
  businessId: string,
  exec: Executor = db,
): Promise<ServiceMedia[]> {
  return exec
    .select()
    .from(serviceMedia)
    .where(eq(serviceMedia.businessId, businessId))
    .orderBy(asc(serviceMedia.serviceId), asc(serviceMedia.displayOrder))
}

/** The media of several services at once, so listing a catalogue is one query. */
export async function listByServices(
  businessId: string,
  serviceIds: string[],
  exec: Executor = db,
): Promise<ServiceMedia[]> {
  if (serviceIds.length === 0) return []
  return exec
    .select()
    .from(serviceMedia)
    .where(
      and(eq(serviceMedia.businessId, businessId), inArray(serviceMedia.serviceId, serviceIds)),
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

/** Everything one service owns. Returns the rows, for the same reason. */
export async function removeByService(
  businessId: string,
  serviceId: string,
  exec: Executor = db,
): Promise<ServiceMedia[]> {
  return exec
    .delete(serviceMedia)
    .where(and(eq(serviceMedia.businessId, businessId), eq(serviceMedia.serviceId, serviceId)))
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
 * An empty `keepServiceIds` means the business has no services left, so
 * everything goes. Written as its own branch because `notInArray(x, [])` is not
 * reliably true across drivers, and getting it wrong here would delete nothing
 * when it should delete everything, or the reverse.
 */
export async function removeOrphans(
  businessId: string,
  keepServiceIds: string[],
  exec: Executor = db,
): Promise<ServiceMedia[]> {
  const where =
    keepServiceIds.length === 0
      ? eq(serviceMedia.businessId, businessId)
      : and(
          eq(serviceMedia.businessId, businessId),
          notInArray(serviceMedia.serviceId, keepServiceIds),
        )

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
