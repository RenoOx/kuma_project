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
