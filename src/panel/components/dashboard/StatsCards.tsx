import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import type { PanelStats, StatsPeriod } from '../../api/types.js'
import { cn } from '../../lib/utils.js'
import { Card, CardContent } from '../ui/card.js'
import { Skeleton } from '../ui/skeleton.js'

const PERIOD_LABEL: Record<StatsPeriod, string> = {
  today: 'vs ayer',
  week: 'vs la semana pasada',
  month: 'vs el mes pasado',
}

/** "45s", "2m 30s". Seconds alone stop being readable past a minute. */
function formatSeconds(seconds: number): string {
  if (seconds <= 0) return '—'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`
}

export function StatsCards({
  stats,
  period,
  isLoading,
}: {
  stats: PanelStats | undefined
  period: StatsPeriod
  isLoading: boolean
}): React.JSX.Element {
  if (isLoading || !stats) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i}>
            <CardContent className="space-y-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-7 w-16" />
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard
        label="Conversaciones"
        value={String(stats.conversations)}
        delta={delta(stats.conversations, stats.prevConversations)}
        deltaLabel={PERIOD_LABEL[period]}
      />
      <StatCard
        label="Citas agendadas"
        value={String(stats.appointments)}
        delta={delta(stats.appointments, stats.prevAppointments)}
        deltaLabel={PERIOD_LABEL[period]}
      />
      {/* No previous-period figure comes back for these two, so they show the
          number alone rather than a comparison the API cannot support. */}
      <StatCard label="Respuesta de Emma" value={formatSeconds(stats.avgResponseTime)} />
      <StatCard label="Conversión a cita" value={`${stats.conversionRate}%`} />
    </div>
  )
}

/**
 * Percent change against the previous period.
 *
 * `undefined` means "draw no comparison line at all" — both periods were empty,
 * and "0% vs ayer" on a quiet day reads as a measurement rather than as an
 * absence of data. `null` is the other empty case: something happened now with
 * nothing before it, where a percentage would divide by zero.
 */
function delta(current: number, previous: number): number | null | undefined {
  if (previous === 0) return current === 0 ? undefined : null
  return Math.round(((current - previous) / previous) * 100)
}

function StatCard({
  label,
  value,
  delta: change,
  deltaLabel,
}: {
  label: string
  value: string
  delta?: number | null
  deltaLabel?: string
}): React.JSX.Element {
  const Icon = change == null || change === 0 ? Minus : change > 0 ? ArrowUpRight : ArrowDownRight

  return (
    <Card>
      <CardContent className="space-y-1">
        <p className="text-emma-text text-xs">{label}</p>
        <p className="text-2xl font-semibold text-emma-text">{value}</p>
        {change !== undefined && (
          <p
            className={cn(
              'flex items-center gap-1 text-xs',
              change == null || change === 0
                ? 'text-muted-foreground'
                : change > 0
                  ? 'text-q-qualified'
                  : 'text-destructive',
            )}
          >
            <Icon size={13} aria-hidden />
            {change == null
              ? 'sin base de comparación'
              : `${change > 0 ? '+' : ''}${change}% ${deltaLabel ?? ''}`}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
