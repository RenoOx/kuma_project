import { useQuery } from '@tanstack/react-query'
import { getPaymentProofs } from '../api/conversations.js'
import type { PaymentProof } from '../api/types.js'
import { useSession } from '../lib/session.js'

/**
 * The deposit captures of one conversation.
 *
 * Not polled. A new capture arrives with a message, and the transcript's own poll
 * is what tells the owner something happened; re-signing these URLs every five
 * seconds would be a signature per proof per tick for a list that rarely changes.
 *
 * The URLs expire in an hour, which the staleTime stays well inside.
 */
export function usePaymentProofs(conversationId: string) {
  const session = useSession()

  return useQuery<PaymentProof[]>({
    queryKey: ['paymentProofs', session.businessId, conversationId],
    queryFn: async () => (await getPaymentProofs(session, conversationId)).proofs,
    staleTime: 30 * 60 * 1000,
  })
}
