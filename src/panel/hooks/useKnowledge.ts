import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PanelApiError } from '../api/client.js'
import {
  createKnowledge,
  deleteKnowledge,
  getKnowledge,
  updateKnowledge,
} from '../api/knowledge.js'
import type { KnowledgeEntry, KnowledgeInput } from '../api/types.js'
import { useSession } from '../lib/session.js'

export function useKnowledge() {
  const session = useSession()
  return useQuery<KnowledgeEntry[]>({
    queryKey: ['knowledge', session.businessId],
    queryFn: () => getKnowledge(session),
    // Only changes from this screen, and every mutation invalidates it.
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export type KnowledgeMutation =
  | { action: 'create'; input: KnowledgeInput }
  | { action: 'update'; id: string; input: KnowledgeInput }
  | { action: 'delete'; id: string }

export interface KnowledgeSave {
  mutate: (payload: KnowledgeMutation) => void
  saving: boolean
  error: string | null
}

/**
 * Create, edit and delete as one mutation.
 *
 * All three end the same way — the entry list moved — so they share an
 * invalidation instead of three copies of it.
 */
export function useKnowledgeMutation(onSuccess?: () => void): KnowledgeSave {
  const session = useSession()
  const queryClient = useQueryClient()

  const mutation = useMutation<unknown, Error, KnowledgeMutation>({
    mutationFn: (payload) => {
      if (payload.action === 'create') return createKnowledge(session, payload.input)
      if (payload.action === 'update') return updateKnowledge(session, payload.id, payload.input)
      return deleteKnowledge(session, payload.id)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['knowledge', session.businessId] })
      onSuccess?.()
    },
  })

  return {
    mutate: (payload) => mutation.mutate(payload),
    saving: mutation.isPending,
    error: mutation.isError ? errorText(mutation.error) : null,
  }
}

function errorText(error: Error): string {
  if (error instanceof PanelApiError && error.userMessage) return error.userMessage
  if (error instanceof PanelApiError && error.status === 400) {
    return 'Revisá los campos marcados.'
  }
  return 'No pudimos guardar. Intentá de nuevo.'
}
