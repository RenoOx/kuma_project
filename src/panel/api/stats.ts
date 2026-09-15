import { apiGet, type PanelSession } from './client.js'
import type { ActivityPoint, PanelOverview, PanelStats, StatsPeriod } from './types.js'

export function getStats(session: PanelSession, period: StatsPeriod): Promise<PanelStats> {
  return apiGet<PanelStats>(session, '/stats', { period })
}

export function getOverview(session: PanelSession): Promise<PanelOverview> {
  return apiGet<PanelOverview>(session, '/stats/overview')
}

export function getActivity(
  session: PanelSession,
  days: number,
): Promise<{ data: ActivityPoint[] }> {
  return apiGet<{ data: ActivityPoint[] }>(session, '/activity', { days: String(days) })
}
