import { logger } from '@/config/logger.js'
import { db } from '@/db/client.js'
import type { Business } from '@/db/schema/index.js'
import * as businessRepo from '@/modules/business/business.repo.js'
import type { BusinessSettings } from '@/modules/business/business.settings.js'
import { fileConfigFor } from '@/modules/conversation/flowSource.js'
import { presetFor, validateFlow } from '@/modules/conversation/stateMachine.js'
import * as googleCredentialsRepo from '@/modules/google/googleCredentials.repo.js'
import * as serviceMediaService from '@/modules/media/serviceMedia.service.js'
import { getConnectionState } from '@/modules/whatsapp/clientRegistry.js'
import { AppError, ValidationError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import type {
  BookingPatch,
  BotPatch,
  ConversationPatch,
  FlowPatch,
  GeneralPatch,
  IdentityPatch,
  MessagesPatch,
  PaymentsPatch,
  SchedulePatch,
  ServicesPatch,
  SpecialDaysPatch,
} from './settings.merge.js'
import {
  botPausedFromPatch,
  identitySettingsPatch,
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

/**
 * Saves the services list, then deletes the files of any service it no longer
 * names.
 *
 * Services arrive as a replaced array: nothing ever says "this one was deleted",
 * it simply stops being in the list. Without the sweep, removing a service from
 * the panel would leave its files in the bucket and its rows in the table
 * forever, referenced by nothing and visible to no one.
 *
 * The sweep runs AFTER the save and cannot fail it. A save that already
 * committed must not be reported as an error because a cleanup could not
 * finish, and the sweep works from the current list rather than from an event —
 * so the next save retries whatever this one missed.
 */
export async function updateServices(
  businessId: string,
  patch: ServicesPatch,
): Promise<Result<BusinessSettings>> {
  const saved = await persistSettings(businessId, patch)
  if (!saved.ok) return saved

  const keep = saved.data.services.map((service) => service.id).filter((id): id is string => !!id)
  await serviceMediaService.purgeOrphans(businessId, 'service', keep)

  return saved
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
 * The refusal a business with a repo config file gets for anything that would
 * change which flow it runs. The file would win anyway — saving would show
 * "guardado" and then do nothing.
 */
function managedByFile(businessId: string, what: string): ValidationError {
  return new ValidationError({
    code: 'flow_managed_by_file',
    message: `business ${businessId} has a repo config file, refusing to change ${what} from the panel`,
    userMessage: 'Este flujo lo administra Vamvu. Si necesitas cambiarlo, contáctanos.',
    logContext: { businessId, what },
  })
}

export async function updateIdentity(
  businessId: string,
  patch: IdentityPatch,
): Promise<Result<BusinessSettings>> {
  // Expanded before it reaches the merge: the form sends one "Función" and the
  // stored shape has two fields for it.
  const fields = identitySettingsPatch(patch)
  // Switching Vende/Agenda would leave the file's flowType disagreeing with the
  // database, and the file would stop applying without anyone noticing.
  const file = fileConfigFor(businessId)
  if (file && fields.flowType !== undefined && fields.flowType !== file.flowType) {
    return err(managedByFile(businessId, 'flowType'))
  }
  return persistSettings(businessId, fields)
}

export function updateMessages(
  businessId: string,
  patch: MessagesPatch,
): Promise<Result<BusinessSettings>> {
  return persistSettings(businessId, patch)
}

export function updateFlow(
  businessId: string,
  patch: FlowPatch,
): Promise<Result<BusinessSettings>> {
  return persistSettings(businessId, patch)
}

/**
 * Stores a composed conversation, and refuses one that cannot run.
 *
 * The validation happens against the MERGED settings, inside the transaction,
 * because whether a node is allowed depends on the rest of this business's
 * configuration: "Métodos de pago" is valid only while requiresDeposit is on.
 * Validating the payload alone would accept a flow that breaks the moment it is
 * read back.
 *
 * This is the whole promise of a configurable flow: a saved flow is a flow that
 * works. Without it, composing is just a faster way to reproduce the bug this
 * was built to kill — a conversation that reaches a step it cannot leave.
 */
export async function updateConversationFlow(
  businessId: string,
  patch: ConversationPatch,
): Promise<Result<BusinessSettings>> {
  if (fileConfigFor(businessId)) return err(managedByFile(businessId, 'conversationFlow'))
  try {
    const saved = await db.transaction(async (tx) => {
      const business = await businessRepo.findById(businessId, tx)
      if (!business) {
        return err(
          new ValidationError({
            code: 'business_not_found',
            message: `business ${businessId} not found while saving the conversation flow`,
            userMessage: 'No encontramos el negocio.',
            logContext: { businessId },
          }),
        )
      }

      const merged = mergeSettingsSection(businessId, business.settings, patch)
      if (!merged.ok) return merged

      const composition = merged.data.conversationFlow
      if (composition) {
        const checked = validateFlow(composition, merged.data)
        if (!checked.ok) return checked
      }

      await businessRepo.update(
        businessId,
        { settings: merged.data as unknown as Record<string, unknown> },
        tx,
      )

      logger.info(
        { businessId, nodes: composition?.nodes ?? null },
        'panel conversation flow updated',
      )
      return ok(merged.data)
    })
    if (!saved.ok) return saved

    // The flow's own orphan sweep, and the mirror of the one in updateServices:
    // a step the owner removed simply stops being in the list, so comparing the
    // stored rows against what the list still names is the only way to notice
    // its files are now unreachable.
    //
    // After the transaction rather than inside it: this talks to S3, and holding
    // a database transaction open across a call to another service is how a slow
    // bucket turns into a lock timeout. Like updateServices, it never fails its
    // caller — the next save retries whatever this one missed.
    const nodes = saved.data.conversationFlow?.nodes ?? presetFor(saved.data).nodes
    await serviceMediaService.purgeOrphans(businessId, 'node', nodes)

    return saved
  } catch (cause) {
    return err(
      new AppError({
        code: 'settings_update_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos guardar el flujo de conversación.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}

// updateServiceImage lived here. A service's files are no longer a field on the
// service — they are rows in `service_media`, with their own CRUD in
// media/serviceMedia.service, which is the only place that can order the bucket
// and the table correctly.

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
