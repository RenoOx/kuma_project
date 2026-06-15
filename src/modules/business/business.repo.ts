import { db, type Executor } from '@/db/client.js'
import { businesses, type Business, type NewBusiness } from '@/db/schema/index.js'
import { eq } from 'drizzle-orm'

export async function findById(id: string, exec: Executor = db): Promise<Business | null> {
  const [row] = await exec.select().from(businesses).where(eq(businesses.id, id)).limit(1)
  return row ?? null
}

export async function findByWhatsappNumber(
  number: string,
  exec: Executor = db,
): Promise<Business | null> {
  const [row] = await exec
    .select()
    .from(businesses)
    .where(eq(businesses.whatsappNumber, number))
    .limit(1)
  return row ?? null
}

export async function create(data: NewBusiness, exec: Executor = db): Promise<Business> {
  const [row] = await exec.insert(businesses).values(data).returning()
  if (!row) throw new Error('insert businesses returned no row')
  return row
}

export async function update(
  id: string,
  data: Partial<NewBusiness>,
  exec: Executor = db,
): Promise<Business> {
  const [row] = await exec
    .update(businesses)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(businesses.id, id))
    .returning()
  if (!row) throw new Error(`business ${id} not found for update`)
  return row
}
