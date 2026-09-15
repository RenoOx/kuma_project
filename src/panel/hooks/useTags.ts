import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PanelApiError } from '../api/client.js'
import {
  assignTags,
  createTag,
  deleteTag,
  getTags,
  setEmmaEnabled,
  type TagInput,
  updateTag,
} from '../api/tags.js'
import type { PanelTag } from '../api/types.js'
import { useSession } from '../lib/session.js'

export function useTags() {
  const session = useSession()
  return useQuery<PanelTag[]>({
    queryKey: ['tags', session.businessId],
    queryFn: () => getTags(session),
    // Only changes from the tag manager, which invalidates it on every write.
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export type TagMutation =
  | { action: 'create'; input: TagInput }
  | { action: 'update'; id: string; input: Partial<TagInput> }
  | { action: 'delete'; id: string }

export interface TagMutationResult {
  mutate: (payload: TagMutation) => void
  saving: boolean
  error: string | null
}

export function useTagMutation(onSuccess?: () => void): TagMutationResult {
  const session = useSession()
  const queryClient = useQueryClient()

  const mutation = useMutation<unknown, Error, TagMutation>({
    mutationFn: (payload) => {
      if (payload.action === 'create') return createTag(session, payload.input)
      if (payload.action === 'update') return updateTag(session, payload.id, payload.input)
      return deleteTag(session, payload.id)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['tags', session.businessId] })
      // Renaming or deleting a label changes what every conversation row shows,
      // and a deleted one has to stop appearing on the threads that carried it.
      void queryClient.invalidateQueries({ queryKey: ['conversations', session.businessId] })
      onSuccess?.()
    },
  })

  return {
    mutate: (payload) => mutation.mutate(payload),
    saving: mutation.isPending,
    error: mutation.isError ? errorText(mutation.error) : null,
  }
}

/** Sets the complete label set on one conversation. */
export function useAssignTags(conversationId: string) {
  const session = useSession()
  const queryClient = useQueryClient()

  return useMutation<PanelTag[], Error, string[]>({
    mutationFn: (tagIds) => assignTags(session, conversationId, tagIds),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations', session.businessId] })
    },
  })
}

/**
 * The per-chat Emma switch.
 *
 * Invalidates messages as well as conversations: the chat header reads the flag
 * off the message page, so without this the switch would snap back on the next
 * poll.
 */
export function useSetEmmaEnabled(conversationId: string) {
  const session = useSession()
  const queryClient = useQueryClient()

  return useMutation<{ success: boolean; enabled: boolean }, Error, boolean>({
    mutationFn: (enabled) => setEmmaEnabled(session, conversationId, enabled),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations', session.businessId] })
      void queryClient.invalidateQueries({ queryKey: ['messages', session.businessId] })
    },
  })
}

function errorText(error: Error): string {
  // The server's userMessage says which rule was hit — the ten-label limit, or
  // a name this business already uses.
  if (error instanceof PanelApiError && error.userMessage) return error.userMessage
  return 'No pudimos guardar. Intentá de nuevo.'
}
