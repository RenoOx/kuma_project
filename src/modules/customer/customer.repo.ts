import { db, type Executor } from '@/db/client.js'
import { customers } from '@/db/schema/index.js'
import { and, eq } from 'drizzle-orm'
import type { Customer, NewCustomer } from './customer.types.js'

export async function findByPhone(
  businessId: string,
  phone: string,
  exec: Executor = db,
): Promise<Customer | null> {
  const [row] = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.phone, phone)))
    .limit(1)
  return row ?? null
}

export async function findById(
  businessId: string,
  id: string,
  exec: Executor = db,
): Promise<Customer | null> {
  const [row] = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.id, id)))
    .limit(1)
  return row ?? null
}

export async function create(data: NewCustomer, exec: Executor = db): Promise<Customer> {
  const [row] = await exec.insert(customers).values(data).returning()
  if (!row) throw new Error('insert customers returned no row')
  return row
}

export async function updateLastSeen(
  businessId: string,
  id: string,
  at: Date,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(customers)
    .set({ lastSeenAt: at, updatedAt: at })
    .where(and(eq(customers.businessId, businessId), eq(customers.id, id)))
}
