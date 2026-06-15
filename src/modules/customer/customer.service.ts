import { AppError, NotFoundError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as customerRepo from './customer.repo.js'
import type { Customer } from './customer.types.js'

export async function getOrCreate(
  businessId: string,
  phone: string,
  name?: string,
): Promise<Result<Customer>> {
  try {
    const existing = await customerRepo.findByPhone(businessId, phone)
    if (existing) {
      const now = new Date()
      await customerRepo.updateLastSeen(businessId, existing.id, now)
      return ok({ ...existing, lastSeenAt: now })
    }
    const created = await customerRepo.create({
      businessId,
      phone,
      name: name ?? null,
      lastSeenAt: new Date(),
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
