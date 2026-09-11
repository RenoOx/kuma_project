import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import type { ActivityPoint } from '../../api/types.js'
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js'
import { Skeleton } from '../ui/skeleton.js'

const AXIS_FMT = new Intl.DateTimeFormat('es-PE', {
  day: '2-digit',
  month: 'short',
  timeZone: 'America/Lima',
})

// The API answers with plain YYYY-MM-DD. Parsing that as a Date would read it
// as UTC midnight and shift the label a day back for a Lima reader, so the
// pieces are formatted directly.
function axisLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day) return date
  return AXIS_FMT.format(new Date(year, month - 1, day))
}

export function ActivityChart({
  data,
  isLoading,
}: {
  data: ActivityPoint[] | undefined
  isLoading: boolean
}): React.JSX.Element {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-emma-text text-sm">Conversaciones por día</CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <Skeleton className="h-56 w-full" />
        ) : (
          <div className="h-56 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
                <CartesianGrid stroke="var(--color-emma-border)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={axisLabel}
                  stroke="var(--color-emma-text-muted)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  minTickGap={24}
                />
                <YAxis
                  stroke="var(--color-emma-text-muted)"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                  width={40}
                />
                <Tooltip
                  cursor={{ stroke: 'var(--color-emma-border)' }}
                  // Recharts types both callbacks against ReactNode, so the
                  // string case is narrowed rather than assumed.
                  labelFormatter={(label) => (typeof label === 'string' ? axisLabel(label) : label)}
                  formatter={(value) => [`${value ?? 0}`, 'Conversaciones']}
                  contentStyle={{
                    backgroundColor: 'var(--color-emma-bg-secondary)',
                    border: '1px solid var(--color-emma-border)',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: 'var(--color-emma-text-muted)' }}
                />
                <Line
                  // Straight segments, not a spline: these are whole
                  // conversations per day, and a curve between 0 and 1 draws
                  // fractions of a conversation that never happened.
                  type="linear"
                  dataKey="conversations"
                  stroke="var(--color-emma-accent)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
