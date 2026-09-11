import { useInfiniteQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { getMessages } from '../api/conversations.js'
import type { MessagePage, PanelMessage } from '../api/types.js'
import type { Qualification } from '../lib/constants.js'
import { useSession } from '../lib/session.js'

const PAGE_SIZE = 50

export interface UseMessagesResult {
  messages: PanelMessage[]
  qualification: Qualification | undefined
  isLoading: boolean
  isError: boolean
  hasEarlier: boolean
  loadEarlier: () => void
  isLoadingEarlier: boolean
}

/**
 * A conversation's transcript, paged backwards from the newest message.
 *
 * Page 1 is the newest slice and each page reads oldest-first, so the pages
 * arrive newest-block-first and have to be reversed as blocks — not flattened
 * in arrival order — to rebuild one chronological transcript. Getting that
 * backwards puts yesterday's messages under today's.
 */
export function useMessages(conversationId: string | null): UseMessagesResult {
  const session = useSession()

  const query = useInfiniteQuery<MessagePage>({
    queryKey: ['messages', session.businessId, conversationId],
    enabled: conversationId !== null,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      // Guarded by `enabled`, so conversationId is set whenever this runs.
      getMessages(session, conversationId as string, pageParam as number, PAGE_SIZE),
    getNextPageParam: (lastPage) => {
      const loaded = lastPage.page * PAGE_SIZE
      return loaded < lastPage.total ? lastPage.page + 1 : undefined
    },
  })

  const messages = useMemo(() => {
    const pages = query.data?.pages ?? []
    return [...pages].reverse().flatMap((page) => page.data)
  }, [query.data])

  return {
    messages,
    // Read off page 1, which is the only page guaranteed to be present.
    qualification: query.data?.pages[0]?.qualification,
    isLoading: query.isLoading,
    isError: query.isError,
    hasEarlier: query.hasNextPage,
    loadEarlier: () => {
      void query.fetchNextPage()
    },
    isLoadingEarlier: query.isFetchingNextPage,
  }
}
