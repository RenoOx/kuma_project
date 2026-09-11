import { useQuery } from '@tanstack/react-query'
import { getHealth, getMe } from '../api/meta.js'
import type { PanelHealth, PanelMe } from '../api/types.js'
import { POLL_MS } from '../lib/constants.js'
import { useSession } from '../lib/session.js'

/** Business identity. Effectively static, so it is not refetched on a timer. */
export function useMe() {
  const session = useSession()
  return useQuery<PanelMe>({
    queryKey: ['me', session.businessId],
    queryFn: () => getMe(session),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useHealth() {
  const session = useSession()
  return useQuery<PanelHealth>({
    queryKey: ['health', session.businessId],
    queryFn: () => getHealth(session),
    refetchInterval: POLL_MS.health,
    refetchIntervalInBackground: true,
  })
}
