import type { InfiniteData, QueryKey } from '@tanstack/react-query'
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
import type { ConversationListItem, MessagePage, Paged, PanelTag } from '../api/types.js'
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
 * Optimistic: writes the flag into both caches the header can read it from
 * before the server answers, so the switch moves the instant it's clicked
 * instead of holding `mutation.variables` until a refetch lands and then
 * possibly snapping back to a stale value in the gap between "not pending
 * anymore" and "invalidated data arrived". `onError` rolls back to the exact
 * snapshot taken in `onMutate`; `onSettled` reconciles with the server
 * regardless of outcome.
 */
export function useSetEmmaEnabled(conversationId: string) {
  const session = useSession()
  const queryClient = useQueryClient()
  const conversationsKey = ['conversations', session.businessId]
  const messagesKey = ['messages', session.businessId, conversationId]

  interface OptimisticContext {
    previousConversations: Array<[QueryKey, Paged<ConversationListItem> | undefined]>
    previousMessages: InfiniteData<MessagePage> | undefined
  }

  return useMutation<{ success: boolean; enabled: boolean }, Error, boolean, OptimisticContext>({
    mutationFn: (enabled) => setEmmaEnabled(session, conversationId, enabled),

    onMutate: async (enabled) => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: conversationsKey }),
        queryClient.cancelQueries({ queryKey: messagesKey }),
      ])

      const previousConversations = queryClient.getQueriesData<Paged<ConversationListItem>>({
        queryKey: conversationsKey,
      })
      const previousMessages = queryClient.getQueryData<InfiniteData<MessagePage>>(messagesKey)

      queryClient.setQueriesData<Paged<ConversationListItem>>(
        { queryKey: conversationsKey },
        (page) =>
          page && {
            ...page,
            data: page.data.map((c) =>
              c.id === conversationId ? { ...c, emmaEnabled: enabled } : c,
            ),
          },
      )

      queryClient.setQueryData<InfiniteData<MessagePage>>(messagesKey, (data) => {
        const first = data?.pages[0]
        if (!data || !first) return data
        return {
          ...data,
          pages: data.pages.map((page, i) => (i === 0 ? { ...first, emmaEnabled: enabled } : page)),
        }
      })

      return { previousConversations, previousMessages }
    },

    onError: (_error, _enabled, context) => {
      if (!context) return
      for (const [key, data] of context.previousConversations) {
        queryClient.setQueryData(key, data)
      }
      queryClient.setQueryData(messagesKey, context.previousMessages)
    },

    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: conversationsKey })
      void queryClient.invalidateQueries({ queryKey: messagesKey })
    },
  })
}

function errorText(error: Error): string {
  // The server's userMessage says which rule was hit — the ten-label limit, or
  // a name this business already uses.
  if (error instanceof PanelApiError && error.userMessage) return error.userMessage
  return 'No pudimos guardar. Intentá de nuevo.'
}
