import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'
import { returnToEmma, sendReply, setQualification } from '../api/conversations.js'
import type { PendingMessage } from '../api/types.js'
import type { ManualQualification } from '../lib/constants.js'
import { useSession } from '../lib/session.js'

/**
 * The owner's reply, drawn before the server has agreed to it (US-06).
 *
 * The optimistic bubble is kept in local state rather than written into the
 * React Query cache. Writing it into the cache means reconciling it against an
 * infinite-query structure of reversed pages that a background poll can replace
 * at any moment — and when that reconciliation slips, the owner sees their own
 * message twice. A separate list appended at the end of the transcript cannot
 * duplicate anything, because the real message and the pending one never live
 * in the same array.
 *
 * The pending entry clears when the refetch that follows brings the real one
 * back, which is the only moment it is safe to drop.
 */
export function useReply(conversationId: string | null) {
  const session = useSession()
  const queryClient = useQueryClient()
  const [pending, setPending] = useState<PendingMessage[]>([])

  const mutation = useMutation({
    mutationFn: async ({ text, localId }: { text: string; localId: string }) => {
      if (!conversationId) throw new Error('no conversation selected')
      void localId
      return await sendReply(session, conversationId, text)
    },

    onMutate: ({ text, localId }) => {
      setPending((current) => [
        ...current,
        {
          id: localId,
          senderType: 'human',
          content: text,
          createdAt: new Date().toISOString(),
          pending: true,
        },
      ])
    },

    onError: (_error, { localId }) => {
      // Kept on screen and marked failed rather than removed: the text the
      // owner typed is the thing they would have to retype, and dropping it is
      // the one outcome they cannot recover from.
      setPending((current) => current.map((m) => (m.id === localId ? { ...m, failed: true } : m)))
    },

    onSuccess: (_data, { localId }) => {
      // The server has the message. Its real copy arrives with the refetch
      // below; until then the optimistic bubble stands in for it, so it is
      // dropped only once that refetch settles.
      void queryClient
        .invalidateQueries({ queryKey: ['messages', session.businessId, conversationId] })
        .then(() => {
          setPending((current) => current.filter((m) => m.id !== localId))
        })
      // The reply also took the conversation over, so the list's badge is stale.
      void queryClient.invalidateQueries({ queryKey: ['conversations', session.businessId] })
    },
  })

  const send = useCallback(
    (text: string) => {
      mutation.mutate({ text, localId: `pending-${crypto.randomUUID()}` })
    },
    [mutation],
  )

  const retry = useCallback(
    (localId: string) => {
      const failed = pending.find((m) => m.id === localId)
      if (!failed) return
      setPending((current) => current.filter((m) => m.id !== localId))
      // A failed send means notifyCustomer never handed the message to
      // WhatsApp — panel.service sends before it persists — so retrying cannot
      // deliver it twice.
      mutation.mutate({ text: failed.content, localId: `pending-${crypto.randomUUID()}` })
    },
    [pending, mutation],
  )

  const dismiss = useCallback((localId: string) => {
    setPending((current) => current.filter((m) => m.id !== localId))
  }, [])

  return { pending, send, retry, dismiss, isSending: mutation.isPending }
}

export function useReturnToEmma(conversationId: string | null) {
  const session = useSession()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async () => {
      if (!conversationId) throw new Error('no conversation selected')
      return await returnToEmma(session, conversationId)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations', session.businessId] })
      void queryClient.invalidateQueries({
        queryKey: ['messages', session.businessId, conversationId],
      })
    },
  })
}

/**
 * The owner setting the label by hand.
 *
 * Both the transcript and the list are invalidated: the badge lives in the chat
 * header, but the same label is drawn on the row behind it, and leaving that
 * stale for up to five seconds would look like the change did not take.
 */
export function useSetQualification(conversationId: string | null) {
  const session = useSession()
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (qualification: ManualQualification) => {
      if (!conversationId) throw new Error('no conversation selected')
      return await setQualification(session, conversationId, qualification)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations', session.businessId] })
      void queryClient.invalidateQueries({
        queryKey: ['messages', session.businessId, conversationId],
      })
      // The dashboard counts conversations by label, so it is stale too.
      void queryClient.invalidateQueries({
        queryKey: ['qualification-breakdown', session.businessId],
      })
    },
  })
}
