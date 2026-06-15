import type { Business, NewBusiness } from '@/db/schema/index.js'
import { AppError, ConflictError, NotFoundError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as businessRepo from './business.repo.js'

// Postgres unique_violation. Used to detect race conditions where another caller
// inserted the same whatsapp_number between our pre-check and the insert.
const PG_UNIQUE_VIOLATION = '23505'

export async function getById(id: string): Promise<Result<Business>> {
  try {
    const found = await businessRepo.findById(id)
    if (!found) {
      return err(
        new NotFoundError({ resource: 'business', logContext: { businessId: id } }),
      )
    }
    return ok(found)
  } catch (cause) {
    return err(
      new AppError({
        code: 'business_get_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos cargar el negocio.',
        logContext: { businessId: id },
        cause,
      }),
    )
  }
}

export async function getByWhatsappNumber(number: string): Promise<Result<Business>> {
  try {
    const found = await businessRepo.findByWhatsappNumber(number)
    if (!found) {
      return err(
        new NotFoundError({
          resource: 'business',
          logContext: { whatsappNumber: number },
        }),
      )
    }
    return ok(found)
  } catch (cause) {
    return err(
      new AppError({
        code: 'business_get_by_whatsapp_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos cargar el negocio.',
        logContext: { whatsappNumber: number },
        cause,
      }),
    )
  }
}

export async function register(data: NewBusiness): Promise<Result<Business>> {
  try {
    const existing = await businessRepo.findByWhatsappNumber(data.whatsappNumber)
    if (existing) {
      return err(
        new ConflictError({
          message: 'whatsapp number already registered',
          userMessage: 'Este número de WhatsApp ya está registrado.',
          logContext: { whatsappNumber: data.whatsappNumber },
        }),
      )
    }
    const created = await businessRepo.create(data)
    return ok(created)
  } catch (cause) {
    if (
      cause instanceof Error &&
      'code' in cause &&
      (cause as { code?: string }).code === PG_UNIQUE_VIOLATION
    ) {
      return err(
        new ConflictError({
          message: 'whatsapp number already registered',
          userMessage: 'Este número de WhatsApp ya está registrado.',
          logContext: { whatsappNumber: data.whatsappNumber },
          cause,
        }),
      )
    }
    return err(
      new AppError({
        code: 'business_register_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos registrar el negocio.',
        logContext: { whatsappNumber: data.whatsappNumber },
        cause,
      }),
    )
  }
}
