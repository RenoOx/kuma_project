import { logger } from '@/config/logger.js'
import { db } from '@/db/client.js'
import type { Business } from '@/db/schema/index.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import * as googleCredentialsRepo from '@/modules/google/googleCredentials.repo.js'
import { getConnectionState } from '@/modules/whatsapp/clientRegistry.js'
import { AppError, ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import type {
  BookingPatch,
  BotPatch,
  GeneralPatch,
  PaymentsPatch,
  SchedulePatch,
  ServicesPatch,
  SpecialDaysPatch,
} from './settings.merge.js'
import {
  botPausedFromPatch,
  mergeSettingsSection,
  type PanelSettingsView,
  readSettings,
} from './settings.merge.js'

// The database-facing half. Everything pure — patch schemas, the merge, the
// read projection — lives in settings.merge.ts and is re-exported here so
// callers still have one import site.
export * from './settings.merge.js'

/** The settings half of a general patch. The rest are columns on `businesses`. */
type SettingsPatch = Partial<BusinessSettings>

/**
 * Persists a settings-only section (schedule, special days, booking).
 *
 * `businessId` is always the one the auth middleware resolved from the path —
 * no caller passes an id from a request body, and no patch schema accepts one.
 * Both the read and the write are filtered by it, inside one transaction so a
 * concurrent write cannot land between them.
 */
async function persistSettings(
  businessId: string,
  patch: SettingsPatch,
): Promise<Result<BusinessSettings>> {
  try {
    return await db.transaction(async (tx) => {
      const business = await businessRepo.findById(businessId, tx)
      if (!business) {
        return err(
          new ValidationError({
            code: 'business_not_found',
            message: `business ${businessId} not found while saving settings`,
            userMessage: 'No encontramos el negocio.',
            logContext: { businessId },
          }),
        )
      }

      const merged = mergeSettingsSection(businessId, business.settings, patch)
      if (!merged.ok) return merged

      await businessRepo.update(
        businessId,
        { settings: merged.data as unknown as Record<string, unknown> },
        tx,
      )

      logger.info({ businessId, fields: Object.keys(patch) }, 'panel settings updated')
      return ok(merged.data)
    })
  } catch (cause) {
    return err(
      new AppError({
        code: 'settings_update_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos guardar la configuración.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}

export function updateSchedule(
  businessId: string,
  patch: SchedulePatch,
): Promise<Result<BusinessSettings>> {
  return persistSettings(businessId, patch)
}

export function updateSpecialDays(
  businessId: string,
  patch: SpecialDaysPatch,
): Promise<Result<BusinessSettings>> {
  return persistSettings(businessId, patch)
}

export function updateBooking(
  businessId: string,
  patch: BookingPatch,
): Promise<Result<BusinessSettings>> {
  return persistSettings(businessId, patch)
}

export function updateServices(
  businessId: string,
  patch: ServicesPatch,
): Promise<Result<BusinessSettings>> {
  return persistSettings(businessId, patch)
}

/**
 * The global pause, from the panel.
 *
 * Goes through the same merge-and-revalidate as every other section, so pausing
 * a business whose settings are incomplete is refused rather than persisted.
 */
export function updateBotPaused(
  businessId: string,
  patch: BotPatch,
): Promise<Result<BusinessSettings>> {
  return persistSettings(businessId, { botPaused: botPausedFromPatch(patch) })
}

export function updatePayments(
  businessId: string,
  patch: PaymentsPatch,
): Promise<Result<BusinessSettings>> {
  return persistSettings(businessId, patch)
}

/**
 * The general section, which writes columns and settings in the same
 * transaction.
 *
 * Kept atomic because the two halves are one form to the owner: a save that
 * moved the business to a new timezone but failed to record the matching niche
 * would leave the panel showing a state nobody asked for.
 */
export async function updateGeneral(
  businessId: string,
  patch: GeneralPatch,
): Promise<Result<PanelSettingsView>> {
  const { niche, appointmentMode, googleMapsUrl, ...columns } = patch

  try {
    return await db.transaction(async (tx) => {
      const business = await businessRepo.findById(businessId, tx)
      if (!business) {
        return err(
          new ValidationError({
            code: 'business_not_found',
            message: `business ${businessId} not found while saving settings`,
            userMessage: 'No encontramos el negocio.',
            logContext: { businessId },
          }),
        )
      }

      const settingsPatch: SettingsPatch = {}
      if (niche !== undefined) settingsPatch.niche = niche
      if (appointmentMode !== undefined) settingsPatch.appointmentMode = appointmentMode

      // Only revalidate when the settings half actually changed. A business
      // still missing its services can rename itself; it just cannot claim to
      // have configured a niche on top of settings that do not parse.
      let nextSettings = business.settings
      if (Object.keys(settingsPatch).length > 0) {
        const merged = mergeSettingsSection(businessId, business.settings, settingsPatch)
        if (!merged.ok) return merged
        nextSettings = merged.data as unknown as Record<string, unknown>
      }

      const columnPatch: Record<string, unknown> = { ...columns }
      // '' is how a text input reports "I cleared this"; the column stores null.
      if (googleMapsUrl !== undefined) {
        columnPatch.googleMapsUrl = googleMapsUrl === '' ? null : googleMapsUrl
      }
      if (Object.keys(settingsPatch).length > 0) columnPatch.settings = nextSettings

      const updated = await businessRepo.update(businessId, columnPatch, tx)

      logger.info({ businessId, fields: Object.keys(patch) }, 'panel general settings updated')
      return ok(readSettings(updated))
    })
  } catch (cause) {
    return err(
      new AppError({
        code: 'settings_update_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos guardar la configuración.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}

// ── Integrations ─────────────────────────────────────────────────────────────

export interface IntegrationsView {
  whatsapp: {
    connected: boolean
    status: string | null
    /** The business's own WhatsApp number, as configured. */
    number: string
    lastEventAt: string | null
  }
  googleCalendar: {
    connected: boolean
    connectedAt: string | null
  }
}

/**
 * Read-only status of both integrations.
 *
 * Deliberately has no counterpart that writes. Pairing a WhatsApp session or
 * dropping one is not exposed to the panel: the credential here is a token in a
 * URL, and a mis-click behind it would take the business's own number off
 * WhatsApp — or, repeated, get it rate-limited. Those two actions stay in the
 * admin surface, operated by Vamvu Labs.
 */
export async function readIntegrations(business: Business): Promise<IntegrationsView> {
  const state = getConnectionState(business.id)
  const credentials = await googleCredentialsRepo.findByBusiness(business.id)

  return {
    whatsapp: {
      connected: state?.status === 'connected',
      status: state?.status ?? null,
      number: business.whatsappNumber,
      lastEventAt: state?.lastEventAt ? new Date(state.lastEventAt).toISOString() : null,
    },
    googleCalendar: {
      connected: credentials !== null,
      connectedAt: credentials?.createdAt ? credentials.createdAt.toISOString() : null,
    },
  }
}
