import { db, type Executor } from '@/db/client.js'
import { appointments, type Appointment, type NewAppointment } from '@/db/schema/index.js'
import { and, asc, eq, gte, lt } from 'drizzle-orm'

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
        gte(appointments.scheduledAt, start),
        lt(appointments.scheduledAt, end),
      ),
    )
    .orderBy(asc(appointments.scheduledAt))
}

export async function findByDateTime(
  businessId: string,
  datetime: Date,
  exec: Executor = db,
): Promise<Appointment | null> {
  const [row] = await exec
    .select()
    .from(appointments)
    .where(and(eq(appointments.businessId, businessId), eq(appointments.scheduledAt, datetime)))
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
