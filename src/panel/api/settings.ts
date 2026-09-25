import { apiGet, apiSend, apiUpload, type PanelSession } from './client.js'
import type {
  BookingPatch,
  BusinessSettingsView,
  ConversationCatalog,
  ConversationFlow,
  FlowPatch,
  GeneralPatch,
  IdentityPatch,
  MessagesPatch,
  OperatingHours,
  PanelIntegrations,
  PanelService,
  PanelSettings,
  PaymentsPatch,
  ServiceMediaView,
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
  // No stripping any more: files are rows keyed by the service id, so this form
  // has nothing of theirs to send back stale. Saving the list does trigger the
  // server's orphan sweep — a service removed here takes its files with it.
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/services', { services })
}

// ── Media ────────────────────────────────────────────────────────────────────
//
// Tres dueños, una sola forma. Un archivo cuelga de un servicio del catálogo,
// de un paso de la conversación, o de un mensaje fijo — y todo lo demás
// (subir, borrar, ordenar) es idéntico, solo cambia la ruta.
//
// Separate from the section PATCHes above: the file is multipart, and an upload
// that failed must not take the owner's text edits down with it.

/** Which list a file belongs to. The server checks the id against that list. */
export interface MediaOwner {
  kind: 'service' | 'node' | 'fixedMessage'
  id: string
}

function mediaBase(owner: MediaOwner): string {
  if (owner.kind === 'node') return `/settings/conversation/nodes/${owner.id}/media`
  if (owner.kind === 'fixedMessage') return `/settings/fixed-messages/${owner.id}/media`
  return `/settings/services/${owner.id}/media`
}

export function getOwnerMedia(
  session: PanelSession,
  owner: MediaOwner,
): Promise<ServiceMediaView[]> {
  return apiGet<ServiceMediaView[]>(session, mediaBase(owner))
}

export function uploadOwnerMedia(
  session: PanelSession,
  owner: MediaOwner,
  file: File,
): Promise<ServiceMediaView> {
  return apiUpload<ServiceMediaView>(session, mediaBase(owner), file)
}

export function deleteOwnerMedia(
  session: PanelSession,
  owner: MediaOwner,
  mediaId: string,
): Promise<{ id: string }> {
  return apiSend<{ id: string }>(session, 'DELETE', `${mediaBase(owner)}/${mediaId}`)
}

/** The arrangement, sent whole — see the server's reorder guard. */
export function reorderOwnerMedia(
  session: PanelSession,
  owner: MediaOwner,
  ids: string[],
): Promise<ServiceMediaView[]> {
  return apiSend<ServiceMediaView[]>(session, 'PATCH', `${mediaBase(owner)}/order`, { ids })
}

export function updatePayments(
  session: PanelSession,
  patch: PaymentsPatch,
): Promise<BusinessSettingsView> {
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/payments', patch)
}

// ── Conversación ─────────────────────────────────────────────────────────────

export function getConversationCatalog(session: PanelSession): Promise<ConversationCatalog> {
  return apiGet<ConversationCatalog>(session, '/settings/conversation/catalog')
}

/**
 * Saves the composed conversation.
 *
 * Can be refused for a reason no form validation catches — a step with no way
 * out, a payment step in a business that charges nothing. The rejection carries
 * a sentence naming the step, which is what the card shows.
 */
export function updateConversation(
  session: PanelSession,
  conversationFlow: ConversationFlow,
): Promise<BusinessSettingsView> {
  return apiSend<BusinessSettingsView>(session, 'PATCH', '/settings/conversation', {
    conversationFlow,
  })
}
