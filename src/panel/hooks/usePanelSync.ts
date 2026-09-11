import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { getUpdates } from '../api/conversations.js'
import { POLL_MS } from '../lib/constants.js'
import { useSession } from '../lib/session.js'

/**
 * The two-step poll of US-03.
 *
 * Every 5 seconds this asks one cheap question — "has anything moved?" — and
 * only when the answer changes does it invalidate the expensive queries. The
 * naive version, polling the conversation list itself at the same cadence,
 * would run a join, a count and a DISTINCT ON twelve times a minute per open
 * tab, forever, to usually learn nothing.
 *
 * The comparison lives in a ref rather than in state on purpose: writing it to
 * state would re-render the whole shell on every tick, which is the cost this
 * design exists to avoid.
 */
export function usePanelSync(): void {
  const session = useSession()
  const queryClient = useQueryClient()
  const lastSeen = useRef<string | null>(null)

  const { data } = useQuery({
    queryKey: ['updates', session.businessId],
    queryFn: () => getUpdates(session),
    refetchInterval: POLL_MS.inbox,
    // Keep polling while the tab is in the background: an owner leaves the
    // panel open in a tab all day, and coming back to a stale inbox is the
    // failure this whole mechanism is meant to prevent.
    refetchIntervalInBackground: true,
  })

  useEffect(() => {
    const marker = data?.lastUpdate
    if (!marker) return

    // First reading establishes the baseline. Invalidating here would throw
    // away the data that was just fetched alongside it.
    if (lastSeen.current === null) {
      lastSeen.current = marker
      return
    }
    if (lastSeen.current === marker) return

    lastSeen.current = marker
    void queryClient.invalidateQueries({ queryKey: ['conversations', session.businessId] })
    void queryClient.invalidateQueries({ queryKey: ['messages', session.businessId] })
  }, [data?.lastUpdate, queryClient, session.businessId])
}
