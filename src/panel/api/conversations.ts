import { apiGet, apiSend, type PanelSession } from './client.js'
import type {
  ConversationListItem,
  MessagePage,
  Paged,
  PaymentProof,
  UpdatesMarker,
} from './types.js'

/**
 * The cheap poll. Called every 5 seconds.
 *
 * `since` is deliberately not sent: the endpoint accepts it, but the client
 * already holds the last timestamp it saw and comparing locally keeps the
 * server stateless about who has seen what.
 */
export function getUpdates(session: PanelSession): Promise<UpdatesMarker> {
  return apiGet<UpdatesMarker>(session, '/updates')
}

export interface ConversationQuery {
  tagId?: string
  search?: string
  page?: number
  limit?: number
}

export function getConversations(
  session: PanelSession,
  query: ConversationQuery,
): Promise<Paged<ConversationListItem>> {
  return apiGet<Paged<ConversationListItem>>(session, '/conversations', {
    ...(query.tagId ? { tagId: query.tagId } : {}),
    ...(query.search ? { search: query.search } : {}),
    page: String(query.page ?? 1),
    limit: String(query.limit ?? 20),
  })
}

/**
 * One page of a transcript.
 *
 * Page 1 is the NEWEST slice (the endpoint defaults to order=desc) and every
 * page comes back oldest-first, so page 2 is "the messages before these" —
 * which is exactly what the chat's "load earlier" button asks for.
 */
export function getMessages(
  session: PanelSession,
  conversationId: string,
  page = 1,
  limit = 50,
): Promise<MessagePage> {
  return apiGet<MessagePage>(session, `/conversations/${conversationId}/messages`, {
    page: String(page),
    limit: String(limit),
  })
}

export function sendReply(
  session: PanelSession,
  conversationId: string,
  text: string,
): Promise<{ success: boolean; messageId: string }> {
  return apiSend(session, 'POST', `/conversations/${conversationId}/reply`, { text })
}

/**
 * The deposit captures this conversation produced, newest first.
 *
 * Separate from the transcript because the image never was a message: it is
 * relayed to the owner's WhatsApp and archived, and the transcript only ever held
 * a text stand-in for it.
 */
export function getPaymentProofs(
  session: PanelSession,
  conversationId: string,
): Promise<{ proofs: PaymentProof[] }> {
  return apiGet<{ proofs: PaymentProof[] }>(
    session,
    `/conversations/${conversationId}/payment-proofs`,
  )
}

export function returnToEmma(
  session: PanelSession,
  conversationId: string,
): Promise<{ success: boolean }> {
  return apiSend(session, 'POST', `/conversations/${conversationId}/return-to-emma`)
}
