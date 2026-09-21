import { apiGet, apiSend, apiUpload, type PanelSession } from './client.js'
import type {
  BookingPatch,
  BusinessSettingsView,
  FlowPatch,
  GeneralPatch,
  IdentityPatch,
  MessagesPatch,
  OperatingHours,
  PanelIntegrations,
  PanelService,
  PanelSettings,
  PaymentsPatch,
  ServiceImage,
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

// ── Asistente tab ────────────────────────────────────────────────────────────
//
// Three sections rather than one, mirroring the three cards: a single PATCH would
// arrive from the Mensajes card with no `assistant` in it, and an absent key means
// "unchanged" only because each section is scoped to what its card owns.

export function updateIdentity(
  session: PanelSession,
  patch: IdentityPatch,
): Promise<BusinessSettingsView> {
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/identity', patch)
}

export function updateMessages(
  session: PanelSession,
  patch: MessagesPatch,
): Promise<BusinessSettingsView> {
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/messages', patch)
}

export function updateFlow(session: PanelSession, patch: FlowPatch): Promise<BusinessSettingsView> {
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/flow', patch)
}

export function getIntegrations(session: PanelSession): Promise<PanelIntegrations> {
  return apiGet<PanelIntegrations>(session, '/integrations')
}

/**
 * The catalogue, replaced whole — the UI owns the list and hands it back entire.
 *
 * Services do carry a stable id, but it is not what addresses them here: the
 * server reconciles ids and photo keys against what it stored, so a list that
 * round-trips unchanged keeps both.
 */
export function updateServices(
  session: PanelSession,
  services: PanelService[],
): Promise<BusinessSettingsView> {
  // imageKey is stripped rather than forwarded. The image endpoints own it, and
  // this list is a draft the form snapshotted on mount — if a photo was uploaded
  // since, the draft still holds the key it replaced, and sending that back would
  // point the service at an object that no longer exists.
  //
  // Omitted, never nulled: the server keeps what it stored for an absent field,
  // while null is how the delete endpoint says "remove the photo".
  const payload = services.map((service) => {
    const { imageKey, ...rest } = service
    return rest
  })
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/services', {
    services: payload,
  })
}

// ── Service photos ───────────────────────────────────────────────────────────
//
// Addressed by service id, and separate from the catalogue PATCH above: the file
// is multipart, and an upload that failed must not take the owner's text edits
// down with it.

export function getServiceImage(session: PanelSession, serviceId: string): Promise<ServiceImage> {
  return apiGet<ServiceImage>(session, `/settings/services/${serviceId}/image`)
}

export function uploadServiceImage(
  session: PanelSession,
  serviceId: string,
  file: File,
): Promise<ServiceImage> {
  return apiUpload<ServiceImage>(session, `/settings/services/${serviceId}/image`, file)
}

export function deleteServiceImage(
  session: PanelSession,
  serviceId: string,
): Promise<ServiceImage> {
  return apiSend<ServiceImage>(session, 'DELETE', `/settings/services/${serviceId}/image`)
}

export function updatePayments(
  session: PanelSession,
  patch: PaymentsPatch,
): Promise<BusinessSettingsView> {
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/payments', patch)
}
