import { apiGet, type PanelSession } from './client.js'
import type { ActivityPoint, PanelStats, QualificationBreakdown, StatsPeriod } from './types.js'

export function getStats(session: PanelSession, period: StatsPeriod): Promise<PanelStats> {
  return apiGet<PanelStats>(session, '/stats', { period })
}

export function getQualificationBreakdown(session: PanelSession): Promise<QualificationBreakdown> {
  return apiGet<QualificationBreakdown>(session, '/stats/qualification-breakdown')
}

export function getActivity(
  session: PanelSession,
  days: number,
): Promise<{ data: ActivityPoint[] }> {
  return apiGet<{ data: ActivityPoint[] }>(session, '/activity', { days: String(days) })
}
