import { db } from '@/db/client.js'
import { AppError, NotFoundError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as customerRepo from './customer.repo.js'
import type { Customer } from './customer.types.js'

/**
 * Finds or creates the customer behind an inbound contact.
 *
 * `waJid` is the JID WhatsApp delivered the message on. It is stored rather
 * than rebuilt from the phone because since the LID migration the two are not
 * interchangeable — see customers.waJid. Optional so callers with no transport
 * context (tests, backfills) still work.
 */
export async function getOrCreate(
  businessId: string,
  phone: string,
  name?: string,
  waJid?: string,
): Promise<Result<Customer>> {
  try {
    const existing = await customerRepo.findByPhone(businessId, phone)
    if (existing) {
      const now = new Date()
      await customerRepo.updateLastSeen(businessId, existing.id, now)
      // Only on an actual change: a customer's JID is stable across thousands
      // of messages, and writing it on every one would be a pointless UPDATE
      // per inbound message.
      const jidChanged = waJid !== undefined && waJid !== existing.waJid
      if (jidChanged) await customerRepo.updateWaJid(businessId, existing.id, waJid)
      return ok({
        ...existing,
        lastSeenAt: now,
        whatsappUnreachableAt: null,
        ...(jidChanged ? { waJid } : {}),
      })
    }
    const created = await customerRepo.create({
      businessId,
      phone,
      name: name ?? null,
      lastSeenAt: new Date(),
      waJid: waJid ?? null,
    })
    return ok(created)
  } catch (cause) {
    return err(
      new AppError({
        code: 'customer_get_or_create_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos registrar tu información, intenta de nuevo.',
        logContext: { businessId, phone },
        cause,
      }),
    )
  }
}

/**
 * Finds or creates the customer behind a phone the OWNER typed in.
 *
 * Not `getOrCreate`: that one is written for an inbound message and carries two
 * side effects that would be lies here. It stamps `lastSeenAt` — booking someone
 * is not that someone getting in touch — and it clears `whatsappUnreachableAt`,
 * which would reopen sending to a number WhatsApp already told us is dead, the
 * exact pattern that gets a line flagged.
 *
 * So: an existing row comes back untouched, and a new one is created with no
 * `lastSeenAt` at all. `phone` must already be normalized by the caller.
 */
export async function getOrCreateManual(
  businessId: string,
  phone: string,
  name?: string,
): Promise<Result<Customer>> {
  try {
    const existing = await customerRepo.findByPhone(businessId, phone)
    if (existing) return ok(existing)

    return ok(
      await customerRepo.create({
        businessId,
        phone,
        name: name?.trim() || null,
      }),
    )
  } catch (cause) {
    return err(
      new AppError({
        code: 'customer_get_or_create_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos registrar a ese contacto, intentá de nuevo.',
        logContext: { businessId, phone },
        cause,
      }),
    )
  }
}

export async function getById(businessId: string, id: string): Promise<Result<Customer>> {
  try {
    const found = await customerRepo.findById(businessId, id)
    if (!found) {
      return err(
        new NotFoundError({
          resource: 'customer',
          logContext: { businessId, customerId: id },
        }),
      )
    }
    return ok(found)
  } catch (cause) {
    return err(
      new AppError({
        code: 'customer_get_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos cargar tus datos.',
        logContext: { businessId, customerId: id },
        cause,
      }),
    )
  }
}

export async function updateLastSeen(businessId: string, id: string): Promise<Result<void>> {
  try {
    const found = await customerRepo.findById(businessId, id)
    if (!found) {
      return err(
        new NotFoundError({
          resource: 'customer',
          logContext: { businessId, customerId: id },
        }),
      )
    }
    await customerRepo.updateLastSeen(businessId, id, new Date())
    return ok(undefined)
  } catch (cause) {
    return err(
      new AppError({
        code: 'customer_update_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos actualizar tu información.',
        logContext: { businessId, customerId: id },
        cause,
      }),
    )
  }
}

// Field names the owner may have configured for the customer's own name. The
// owner writes collectDataFields freely ("nombre", "Nombre completo"), so this
// matches on the stem rather than on an exact string.
const NAME_FIELD = /nombre|name/i

/** Where the collected answers live inside `customers.metadata`. */
const COLLECTED_KEY = 'collected'

export type CollectedData = Record<string, string>

/** The answers this customer has given, as the owner named the fields. */
export function collectedDataOf(customer: Customer): CollectedData {
  const blob = customer.metadata
  if (typeof blob !== 'object' || blob === null) return {}
  const bucket = (blob as Record<string, unknown>)[COLLECTED_KEY]
  if (typeof bucket !== 'object' || bucket === null) return {}
  return Object.fromEntries(
    Object.entries(bucket as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  )
}

/**
 * Persists what the collect-data step gathered.
 *
 * The name reaches its own column, because a column is what the rest of the app
 * reads it from. Everything else lands in `metadata.collected`, keyed by the
 * field name the owner wrote.
 *
 * Until this, every field but the name was accepted, acknowledged and dropped:
 * it survived only in the conversation transcript. That is fine for a human
 * reading a chat and useless for anything else — a flow cannot branch on "this
 * student already has the prerequisite" if the answer was never stored.
 *
 * MERGED, never replaced. A customer who corrects one field in
 * `correccion_datos` must not lose the four they already answered, and the
 * merge happens in one transaction so two turns arriving together cannot
 * overwrite each other with a stale read.
 */
export async function saveCollectedData(
  businessId: string,
  id: string,
  fields: Record<string, string>,
): Promise<Result<void>> {
  try {
    await db.transaction(async (tx) => {
      const found = await customerRepo.findById(businessId, id, tx)
      if (!found)
        throw new NotFoundError({
          resource: 'customer',
          logContext: { businessId, customerId: id },
        })

      const nameEntry = Object.entries(fields).find(([key]) => NAME_FIELD.test(key))
      const name = nameEntry?.[1]?.trim()
      if (name) await customerRepo.updateName(businessId, id, name, tx)

      const clean = Object.fromEntries(
        Object.entries(fields)
          .map(([key, value]) => [key, value.trim()] as const)
          .filter(([, value]) => value !== ''),
      )
      if (Object.keys(clean).length === 0) return

      const blob =
        typeof found.metadata === 'object' && found.metadata !== null
          ? (found.metadata as Record<string, unknown>)
          : {}
      await customerRepo.updateMetadata(
        businessId,
        id,
        { ...blob, [COLLECTED_KEY]: { ...collectedDataOf(found), ...clean } },
        tx,
      )
    })

    return ok(undefined)
  } catch (cause) {
    if (cause instanceof NotFoundError) return err(cause)
    return err(
      new AppError({
        code: 'customer_update_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos guardar tus datos.',
        logContext: { businessId, customerId: id, fields: Object.keys(fields) },
        cause,
      }),
    )
  }
}
