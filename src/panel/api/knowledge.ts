import { apiGet, apiSend, type PanelSession } from './client.js'
import type { KnowledgeEntry, KnowledgeInput } from './types.js'

/** Every entry, inactive ones included — the list greys them out rather than hiding them. */
export function getKnowledge(session: PanelSession): Promise<KnowledgeEntry[]> {
  return apiGet<KnowledgeEntry[]>(session, '/knowledge')
}

export function createKnowledge(
  session: PanelSession,
  input: KnowledgeInput,
): Promise<KnowledgeEntry> {
  return apiSend<KnowledgeEntry>(session, 'POST', '/knowledge', input)
}

export function updateKnowledge(
  session: PanelSession,
  id: string,
  input: KnowledgeInput,
): Promise<KnowledgeEntry> {
  return apiSend<KnowledgeEntry>(session, 'PATCH', `/knowledge/${id}`, input)
}

export function deleteKnowledge(
  session: PanelSession,
  id: string,
): Promise<{ deleted: string }> {
  return apiSend<{ deleted: string }>(session, 'DELETE', `/knowledge/${id}`)
}
