import { useQuery } from '@tanstack/react-query'
import { getActivity, getQualificationBreakdown, getStats } from '../api/stats.js'
import type {
  ActivityPoint,
  PanelStats,
  QualificationBreakdown,
  StatsPeriod,
} from '../api/types.js'
import { POLL_MS } from '../lib/constants.js'
import { useSession } from '../lib/session.js'

export function useStats(period: StatsPeriod) {
  const session = useSession()

  return useQuery<PanelStats>({
    queryKey: ['stats', session.businessId, period],
    queryFn: () => getStats(session, period),
    refetchInterval: POLL_MS.dashboard,
  })
}

export function useQualificationBreakdown() {
  const session = useSession()

  return useQuery<QualificationBreakdown>({
    queryKey: ['qualification-breakdown', session.businessId],
    queryFn: () => getQualificationBreakdown(session),
    refetchInterval: POLL_MS.dashboard,
  })
}

export function useActivity(days = 30) {
  const session = useSession()

  // Typed as <raw, error, selected>: the endpoint answers { data: [...] } and
  // every caller wants the array, so the unwrapping happens once here.
  return useQuery<{ data: ActivityPoint[] }, Error, ActivityPoint[]>({
    queryKey: ['activity', session.businessId, days],
    queryFn: () => getActivity(session, days),
    refetchInterval: POLL_MS.dashboard,
    select: (response) => response.data,
  })
}
