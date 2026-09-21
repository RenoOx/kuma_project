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

/**
 * Persists what the collect-data step gathered.
 *
 * Only the name reaches a column today, because that is the only one the
 * customer row has. It is also the one that mattered: until this existed, a
 * customer who told Emma their name and did not go on to book kept whatever
 * push name WhatsApp happened to carry, which is the gap CLAUDE.md lists under
 * "pendientes conocidos".
 *
 * The other fields are accepted and acknowledged rather than dropped silently —
 * they live in the conversation transcript, which is where the owner reads them
 * today. Giving them a home of their own is a schema change, not this function.
 */
export async function saveCollectedData(
  businessId: string,
  id: string,
  fields: Record<string, string>,
): Promise<Result<void>> {
  try {
    const found = await customerRepo.findById(businessId, id)
    if (!found) {
      return err(
        new NotFoundError({ resource: 'customer', logContext: { businessId, customerId: id } }),
      )
    }

    const nameEntry = Object.entries(fields).find(([key]) => NAME_FIELD.test(key))
    const name = nameEntry?.[1]?.trim()
    if (name) await customerRepo.updateName(businessId, id, name)

    return ok(undefined)
  } catch (cause) {
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
