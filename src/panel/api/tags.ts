import type { TagColor } from '../lib/constants.js'
import { apiGet, apiSend, type PanelSession } from './client.js'
import type { PanelTag } from './types.js'

export interface TagInput {
  name: string
  color: TagColor
}

export function getTags(session: PanelSession): Promise<PanelTag[]> {
  return apiGet<PanelTag[]>(session, '/tags')
}

export function createTag(session: PanelSession, input: TagInput): Promise<PanelTag> {
  return apiSend<PanelTag>(session, 'POST', '/tags', input)
}

export function updateTag(
  session: PanelSession,
  id: string,
  input: Partial<TagInput>,
): Promise<PanelTag> {
  return apiSend<PanelTag>(session, 'PATCH', `/tags/${id}`, input)
}

export function deleteTag(session: PanelSession, id: string): Promise<{ deleted: string }> {
  return apiSend<{ deleted: string }>(session, 'DELETE', `/tags/${id}`)
}

/**
 * Sets the complete label set of one conversation.
 *
 * Sends the whole set rather than an add/remove, so clicking three labels in a
 * row cannot interleave into a state neither click asked for.
 */
export function assignTags(
  session: PanelSession,
  conversationId: string,
  tagIds: string[],
): Promise<PanelTag[]> {
  // PUT because sending it twice leaves the same state — it replaces the set.
  return apiSend<PanelTag[]>(session, 'PUT', `/conversations/${conversationId}/tags`, { tagIds })
}

export function setEmmaEnabled(
  session: PanelSession,
  conversationId: string,
  enabled: boolean,
): Promise<{ success: boolean; enabled: boolean }> {
  return apiSend<{ success: boolean; enabled: boolean }>(
    session,
    'PATCH',
    `/conversations/${conversationId}/emma`,
    { enabled },
  )
}
