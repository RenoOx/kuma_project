import { and, eq, like, sql } from 'drizzle-orm'
import { db, type Executor } from '@/db/client.js'
import { customers } from '@/db/schema/index.js'
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

/**
 * La ficha que WhatsApp entrega por este JID. Si hubiera más de una (fichas
 * anteriores a `wa_jid`), la que escribió último.
 */
export async function findByWaJid(
  businessId: string,
  waJid: string,
  exec: Executor = db,
): Promise<Customer | null> {
  const [row] = await exec
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), eq(customers.waJid, waJid)))
    .orderBy(sql`${customers.lastSeenAt} desc nulls last`)
    .limit(1)
  return row ?? null
}

/** Fichas que llegaron por un `@lid`: las candidatas a tener un teléfono que es el LID. */
export async function listWithLidJid(businessId: string, exec: Executor = db): Promise<Customer[]> {
  return exec
    .select()
    .from(customers)
    .where(and(eq(customers.businessId, businessId), like(customers.waJid, '%@lid')))
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

// Overwrites whatever WhatsApp handed us as the push name with the name the
// customer actually gave Emma. Returns the fresh row so the caller doesn't have
// to read it back.
export async function updateName(
  businessId: string,
  id: string,
  name: string,
  exec: Executor = db,
): Promise<Customer | null> {
  const [row] = await exec
    .update(customers)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(customers.businessId, businessId), eq(customers.id, id)))
    .returning()
  return row ?? null
}

export async function updateLastSeen(
  businessId: string,
  id: string,
  at: Date,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(customers)
    // Clearing whatsappUnreachableAt here is the point of doing it in this
    // function: an inbound message IS proof the number is alive, and this runs
    // on every one of them. A customer who was flagged while their phone was
    // off must not stay excluded from reminders forever.
    .set({ lastSeenAt: at, whatsappUnreachableAt: null, updatedAt: at })
    .where(and(eq(customers.businessId, businessId), eq(customers.id, id)))
}

/**
 * Records the transport address WhatsApp routes this customer by.
 *
 * Called only when the JID actually changed: a contact can move from "<lid>@lid"
 * to "<phone>@s.whatsapp.net" once WhatsApp exposes their number, and the newer
 * one is the one future proactive sends have to use.
 */
/**
 * Replaces the metadata blob. Callers merge; this writes what they hand over.
 *
 * Kept dumb on purpose: merging needs the previous value, and reading it inside
 * an update would make two customers answering at once silently overwrite each
 * other. The service reads and merges in one transaction instead.
 */
export async function updateMetadata(
  businessId: string,
  id: string,
  metadata: Record<string, unknown>,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(customers)
    .set({ metadata, updatedAt: new Date() })
    .where(and(eq(customers.businessId, businessId), eq(customers.id, id)))
}

/**
 * Corrige el teléfono de una ficha en el lugar: el LID que se usó como número
 * pasa a ser el número real, y la ficha conserva su historial, conversaciones y
 * etiquetas. El que llama verifica antes que ninguna otra ficha tenga ese número
 * (UNIQUE business_id + phone).
 */
export async function updatePhone(
  businessId: string,
  id: string,
  phone: string,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(customers)
    .set({ phone, updatedAt: new Date() })
    .where(and(eq(customers.businessId, businessId), eq(customers.id, id)))
}

/** El @usuario guardado por `setWaUsername`, para seleccionarlo sin traer todo `metadata`. */
export const WA_USERNAME_SQL = sql<string | null>`${customers.metadata}->>'waUsername'`

/**
 * Guarda el @usuario de WhatsApp (o que no tiene) y cuándo se consultó.
 *
 * Se mezcla en el mismo UPDATE (`metadata || …`) en vez de leer y reescribir el
 * blob: ahí también viven los datos que recolecta Emma, y un leer-mezclar-escribir
 * en paralelo con ella podía borrarlos.
 */
export async function setWaUsername(
  businessId: string,
  id: string,
  username: string | null,
  checkedAt: Date,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(customers)
    .set({
      metadata: sql`${customers.metadata} || jsonb_build_object('waUsername', ${username}::text, 'waUsernameCheckedAt', ${checkedAt.toISOString()}::text)`,
      updatedAt: new Date(),
    })
    .where(and(eq(customers.businessId, businessId), eq(customers.id, id)))
}

export async function updateWaJid(
  businessId: string,
  id: string,
  waJid: string,
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(customers)
    .set({ waJid, updatedAt: new Date() })
    .where(and(eq(customers.businessId, businessId), eq(customers.id, id)))
}

/**
 * Flags a customer WhatsApp says has no account behind their JID, so proactive
 * sends stop targeting them.
 *
 * Not a delete and not a hard block: the flag is cleared by updateLastSeen the
 * moment they write again, because the only evidence that outranks WhatsApp's
 * "does not exist" is the person actually messaging us.
 */
export async function markWhatsappUnreachable(
  businessId: string,
  id: string,
  at: Date = new Date(),
  exec: Executor = db,
): Promise<void> {
  await exec
    .update(customers)
    .set({ whatsappUnreachableAt: at, updatedAt: at })
    .where(and(eq(customers.businessId, businessId), eq(customers.id, id)))
}
