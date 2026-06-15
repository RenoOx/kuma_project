import { db, type Executor } from '@/db/client.js'
import { events, type Event, type NewEvent } from '@/db/schema/index.js'

export async function create(data: NewEvent, exec: Executor = db): Promise<Event> {
  const [row] = await exec.insert(events).values(data).returning()
  if (!row) throw new Error('insert events returned no row')
  return row
}
