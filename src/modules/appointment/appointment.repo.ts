import { db, type Executor } from '@/db/client.js'
import {
  appointments,
  customers,
  type Appointment,
  type NewAppointment,
} from '@/db/schema/index.js'
import { and, asc, count, eq, gte, isNull, lt, lte, ne, sql } from 'drizzle-orm'

// Appointments occupying [start, end). Cancelled ones are excluded: they no
// longer hold their slot, and counting them kept the slot blocked forever —
// Emma told customers a freed-up time was taken.
export async function findByBusinessAndDateRange(
  businessId: string,
  start: Date,
  end: Date,
  exec: Executor = db,
): Promise<Appointment[]> {
  return await exec
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, businessId),
        ne(appointments.status, 'cancelled'),
        gte(appointments.scheduledAt, start),
        lt(appointments.scheduledAt, end),
      ),
    )
    .orderBy(asc(appointments.scheduledAt))
}

// First non-cancelled appointment whose own interval
// [scheduled_at, scheduled_at + duration_minutes) overlaps [start, end).
//
// This is the authoritative conflict check. Matching on the start instant
// alone — what this replaced — let a 60-min appointment at 10:00 coexist with
// anything booked at 10:30, because only 10:00 was ever considered occupied.
//
// Touching boundaries do NOT overlap: an appointment ending exactly at 10:00
// leaves 10:00 bookable, matching the semantics of overlapsBreak in the service.
export async function findOverlapping(
  businessId: string,
  start: Date,
  end: Date,
  exec: Executor = db,
): Promise<Appointment | null> {
  const [row] = await exec
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, businessId),
        ne(appointments.status, 'cancelled'),
        lt(appointments.scheduledAt, end),
        // `start` is serialized by hand: inside a raw sql template drizzle has
        // no column type to encode against and would hand postgres-js the Date
        // object itself, which it refuses. The ISO string carries its UTC
        // offset, so the cast is unambiguous.
        sql`${appointments.scheduledAt} + (${appointments.durationMinutes} * interval '1 minute') > ${start.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(appointments.scheduledAt))
    .limit(1)
  return row ?? null
}

// Looks for a recently-created appointment matching the exact (customer, slot,
// service) tuple. Backs the idempotency window in bookAppointment.
export async function findRecentByCustomerSlot(
  businessId: string,
  customerId: string,
  datetime: Date,
  service: string,
  windowMs: number,
  exec: Executor = db,
): Promise<Appointment | null> {
  const since = new Date(Date.now() - windowMs)
  const [row] = await exec
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, businessId),
        eq(appointments.customerId, customerId),
        eq(appointments.scheduledAt, datetime),
        eq(appointments.service, service),
        gte(appointments.createdAt, since),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function create(data: NewAppointment, exec: Executor = db): Promise<Appointment> {
  const [row] = await exec.insert(appointments).values(data).returning()
  if (!row) throw new Error('insert appointments returned no row')
  return row
}

export async function findById(
  businessId: string,
  id: string,
  exec: Executor = db,
): Promise<Appointment | null> {
  const [row] = await exec
    .select()
    .from(appointments)
    .where(and(eq(appointments.businessId, businessId), eq(appointments.id, id)))
    .limit(1)
  return row ?? null
}

export interface AppointmentWithCustomer {
  id: string
  service: string
  scheduledAt: Date
  durationMinutes: number
  status: string
  customerName: string | null
  customerPhone: string
}

// Lists appointments scheduled in [start, end) with the customer's name and
// phone joined in. Used by the owner's `get_appointments` tool.
export async function listScheduledInRange(
  businessId: string,
  start: Date,
  end: Date,
  limit = 20,
  exec: Executor = db,
): Promise<AppointmentWithCustomer[]> {
  return await exec
    .select({
      id: appointments.id,
      service: appointments.service,
      scheduledAt: appointments.scheduledAt,
      durationMinutes: appointments.durationMinutes,
      status: appointments.status,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(appointments)
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .where(
      and(
        eq(appointments.businessId, businessId),
        gte(appointments.scheduledAt, start),
        lt(appointments.scheduledAt, end),
      ),
    )
    .orderBy(asc(appointments.scheduledAt))
    .limit(limit)
}

// Every request still waiting on the owner's call, oldest slot first. Joined
// with the customer because the owner has to recognise WHO is asking before
// deciding anything. Backs the owner's `list_pending_appointments` tool.
export async function findPendingByBusiness(
  businessId: string,
  exec: Executor = db,
): Promise<AppointmentWithCustomer[]> {
  return await exec
    .select({
      id: appointments.id,
      service: appointments.service,
      scheduledAt: appointments.scheduledAt,
      durationMinutes: appointments.durationMinutes,
      status: appointments.status,
      customerName: customers.name,
      customerPhone: customers.phone,
    })
    .from(appointments)
    .innerJoin(customers, eq(customers.id, appointments.customerId))
    .where(and(eq(appointments.businessId, businessId), eq(appointments.status, 'pending')))
    .orderBy(asc(appointments.scheduledAt))
}

// Counts appointments CREATED in [since, until). Used by the owner's
// daily-summary tool to report "agendaste N citas hoy".
export async function countCreatedInRange(
  businessId: string,
  since: Date,
  until: Date,
  exec: Executor = db,
): Promise<number> {
  const [row] = await exec
    .select({ value: count() })
    .from(appointments)
    .where(
      and(
        eq(appointments.businessId, businessId),
        gte(appointments.createdAt, since),
        lt(appointments.createdAt, until),
      ),
    )
  return row?.value ?? 0
}

export type ReminderKind = '24h' | '2h'

// Lists scheduled appointments whose `scheduled_at` falls inside the given
// window AND whose corresponding reminder column is still NULL. NOT filtered
// by businessId: the worker runs cross-tenant and the per-business send is
// gated by the registry instead.
export async function findDueForReminder(
  kind: ReminderKind,
  windowStart: Date,
  windowEnd: Date,
  exec: Executor = db,
): Promise<Appointment[]> {
  const column =
    kind === '24h' ? appointments.reminder24hSentAt : appointments.reminder2hSentAt
  return await exec
    .select()
    .from(appointments)
    .where(
      and(
        eq(appointments.status, 'scheduled'),
        isNull(column),
        gte(appointments.scheduledAt, windowStart),
        lte(appointments.scheduledAt, windowEnd),
      ),
    )
    .orderBy(asc(appointments.scheduledAt))
}

// Records that we dispatched the `kind` reminder for an appointment. Idempotent
// at the worker level because the next query iteration won't pick the row up
// (the column is no longer NULL).
export async function markReminderSent(
  businessId: string,
  id: string,
  kind: ReminderKind,
  at: Date = new Date(),
  exec: Executor = db,
): Promise<void> {
  const set =
    kind === '24h'
      ? { reminder24hSentAt: at, updatedAt: at }
      : { reminder2hSentAt: at, updatedAt: at }
  await exec
    .update(appointments)
    .set(set)
    .where(and(eq(appointments.businessId, businessId), eq(appointments.id, id)))
}

export async function update(
  businessId: string,
  id: string,
  partial: Partial<NewAppointment>,
  exec: Executor = db,
): Promise<Appointment> {
  const [row] = await exec
    .update(appointments)
    .set({ ...partial, updatedAt: new Date() })
    .where(and(eq(appointments.businessId, businessId), eq(appointments.id, id)))
    .returning()
  if (!row) throw new Error(`appointment ${id} not found for update`)
  return row
}
