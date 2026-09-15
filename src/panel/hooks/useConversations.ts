import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { getConversations } from '../api/conversations.js'
import type { ConversationListItem, Paged } from '../api/types.js'
import { useSession } from '../lib/session.js'

export interface UseConversationsArgs {
  /** One of the owner's tag ids. Absent means every conversation. */
  tagId?: string
  search?: string
  page: number
}

export function useConversations(args: UseConversationsArgs) {
  const session = useSession()

  return useQuery<Paged<ConversationListItem>>({
    queryKey: [
      'conversations',
      session.businessId,
      args.tagId ?? 'all',
      args.search ?? '',
      args.page,
    ],
    queryFn: () =>
      getConversations(session, {
        ...(args.tagId ? { tagId: args.tagId } : {}),
        ...(args.search ? { search: args.search } : {}),
        page: args.page,
      }),
    // Switching tabs or typing in the search box keeps the previous list on
    // screen instead of collapsing to a spinner and back. usePanelSync drives
    // the refreshes; this only smooths what the owner does by hand.
    placeholderData: keepPreviousData,
  })
}
