import { useState } from 'react'
import type { StatsPeriod } from '../api/types.js'
import { ActivityChart } from '../components/dashboard/ActivityChart.js'
import { OverviewStats } from '../components/dashboard/OverviewStats.js'
import { StatsCards } from '../components/dashboard/StatsCards.js'
import { Tabs, TabsList, TabsTrigger } from '../components/ui/tabs.js'
import { useMe } from '../hooks/useMeta.js'
import { useActivity, useOverview, useStats } from '../hooks/useStats.js'
import { nicheCopy } from '../lib/constants.js'

const PERIODS: Array<{ value: StatsPeriod; label: string }> = [
  { value: 'today', label: 'Hoy' },
  { value: 'week', label: 'Semana' },
  { value: 'month', label: 'Mes' },
]

function toPeriod(value: string): StatsPeriod {
  const match = PERIODS.find((p) => p.value === value)
  return match ? match.value : 'today'
}

export function DashboardPage(): React.JSX.Element {
  const [period, setPeriod] = useState<StatsPeriod>('today')
  const { data: me } = useMe()
  const copy = nicheCopy(me?.niche)

  const stats = useStats(period)
  const overview = useOverview()
  const activity = useActivity(30)

  return (
    <div className="h-full min-h-0 overflow-y-auto">
      {/* No padding of its own: the shell's gutter is the one that lines the
          cards up with the blocks on every other screen. */}
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-base font-semibold text-emma-text">{copy.dashboardTitle}</h1>
            {me && <p className="text-muted-foreground text-xs">{me.name}</p>}
          </div>

          <Tabs value={period} onValueChange={(value) => setPeriod(toPeriod(value))}>
            <TabsList>
              {PERIODS.map((p) => (
                <TabsTrigger key={p.value} value={p.value} className="px-3">
                  {p.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </header>

        <StatsCards stats={stats.data} period={period} isLoading={stats.isLoading} />

        <section className="space-y-2">
          <h2 className="text-emma-text text-xs font-medium">Conversaciones por estado</h2>
          <OverviewStats overview={overview.data} isLoading={overview.isLoading} />
        </section>

        <ActivityChart data={activity.data} isLoading={activity.isLoading} />

        {(stats.isError || overview.isError || activity.isError) && (
          <p className="text-destructive text-xs">
            Algunas métricas no cargaron. Se reintenta solo en unos segundos.
          </p>
        )}
      </div>
    </div>
  )
}
