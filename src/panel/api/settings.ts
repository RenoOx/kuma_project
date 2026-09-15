import { apiGet, apiSend, type PanelSession } from './client.js'
import type {
  BookingPatch,
  BusinessSettingsView,
  GeneralPatch,
  OperatingHours,
  PanelIntegrations,
  PanelService,
  PanelSettings,
  PaymentsPatch,
  SpecialDay,
} from './types.js'

export function getSettings(session: PanelSession): Promise<PanelSettings> {
  return apiGet<PanelSettings>(session, '/settings')
}

/** Identity, niche and attention mode. Answers with the whole view — it writes columns too. */
export function updateGeneral(session: PanelSession, patch: GeneralPatch): Promise<PanelSettings> {
  return apiSend<PanelSettings>(session, 'PATCH', '/settings/general', patch)
}

// The three below answer with the merged BusinessSettings, not the full view:
// none of them touches a column on `businesses`.

export function updateSchedule(
  session: PanelSession,
  operatingHours: OperatingHours,
): Promise<BusinessSettingsView> {
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/schedule', { operatingHours })
}

/** Full replacement of the list — the UI owns it entire, so deletions come through. */
export function updateSpecialDays(
  session: PanelSession,
  specialDays: SpecialDay[],
): Promise<BusinessSettingsView> {
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/special-days', { specialDays })
}

export function updateBooking(
  session: PanelSession,
  patch: BookingPatch,
): Promise<BusinessSettingsView> {
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/booking', patch)
}

export function getIntegrations(session: PanelSession): Promise<PanelIntegrations> {
  return apiGet<PanelIntegrations>(session, '/integrations')
}

/** The catalogue, replaced whole — services have no stable id to address one by. */
export function updateServices(
  session: PanelSession,
  services: PanelService[],
): Promise<BusinessSettingsView> {
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/services', { services })
}

export function updatePayments(
  session: PanelSession,
  patch: PaymentsPatch,
): Promise<BusinessSettingsView> {
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/payments', patch)
}
