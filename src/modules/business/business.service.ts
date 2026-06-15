import type { Business, NewBusiness } from '@/db/schema/index.js'
import { AppError, ConflictError, NotFoundError, ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as businessRepo from './business.repo.js'
import {
  businessSettingsSchema,
  parseBusinessSettings,
  type BusinessSettings,
} from './business.settings.js'

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

export async function getSettings(businessId: string): Promise<Result<BusinessSettings>> {
  try {
    const business = await businessRepo.findById(businessId)
    if (!business) {
      return err(
        new NotFoundError({ resource: 'business', logContext: { businessId } }),
      )
    }
    return parseBusinessSettings(businessId, business.settings)
  } catch (cause) {
    return err(
      new AppError({
        code: 'business_get_settings_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos cargar la configuración del negocio.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}

export async function updateSettings(
  businessId: string,
  partial: Partial<BusinessSettings>,
): Promise<Result<BusinessSettings>> {
  try {
    const business = await businessRepo.findById(businessId)
    if (!business) {
      return err(
        new NotFoundError({ resource: 'business', logContext: { businessId } }),
      )
    }

    // Shallow merge — callers replace top-level keys (operatingHours, services,
    // slotDurationMinutes) atomically. Day-by-day or per-service edits would
    // need an admin layer; not for V1.
    const current =
      business.settings && typeof business.settings === 'object' && !Array.isArray(business.settings)
        ? (business.settings as Record<string, unknown>)
        : {}
    const merged = { ...current, ...partial }

    const parsed = businessSettingsSchema.safeParse(merged)
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.length === 0 ? '<root>' : i.path.join('.')}: ${i.message}`,
      )
      return err(
        new ValidationError({
          message: `invalid settings after merge: ${issues.join('; ')}`,
          userMessage: 'La configuración enviada no es válida.',
          logContext: { businessId, issues },
        }),
      )
    }

    await businessRepo.update(businessId, { settings: parsed.data })
    return ok(parsed.data)
  } catch (cause) {
    return err(
      new AppError({
        code: 'business_update_settings_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos guardar la configuración del negocio.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}
