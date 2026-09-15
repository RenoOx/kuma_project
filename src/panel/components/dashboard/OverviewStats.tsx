import { CalendarCheck, Clock, MessageSquare, UserCheck } from 'lucide-react'
import type { PanelOverview } from '../../api/types.js'
import { PanelLink } from '../../lib/session.js'
import { Skeleton } from '../ui/skeleton.js'

/**
 * Where the business stands right now (US-08 AC2).
 *
 * Replaced the qualification breakdown, and the difference is the point: every
 * number here is a fact the database already knows, so it says something real
 * on day one and for a business that never creates a single label. The old bar
 * counted a model's read of how warm each lead looked, which was empty until
 * Emma had judged enough conversations to fill it.
 *
 * The first three link into the inbox, which is what makes a number actionable:
 * "3 sin responder" is a report, three threads you can open is a to-do list.
 */
export function OverviewStats({
  overview,
  isLoading,
}: {
  overview: PanelOverview | undefined
  isLoading: boolean
}): React.JSX.Element {
  if (isLoading || !overview) {
    return (
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <Tile
        icon={<MessageSquare size={15} aria-hidden />}
        label="Conversaciones abiertas"
        value={overview.openConversations}
        to="/"
      />
      <Tile
        icon={<Clock size={15} aria-hidden />}
        label="Sin responder"
        value={overview.awaitingReply}
        to="/"
        tone="text-q-needs-info"
      />
      <Tile
        icon={<UserCheck size={15} aria-hidden />}
        label="Atendidas por vos"
        value={overview.handledByOwner}
        to="/"
      />
      <Tile
        icon={<CalendarCheck size={15} aria-hidden />}
        label="Citas próximas"
        value={overview.upcomingAppointments}
        to="/citas"
      />
    </div>
  )
}

function Tile({
  icon,
  label,
  value,
  to,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: number
  to: string
  tone?: string
}): React.JSX.Element {
  return (
    <PanelLink
      to={to}
      className="bg-card hover:border-primary/50 flex flex-col gap-1 rounded-lg border border-border p-3 transition-colors"
    >
      <span className="text-muted-foreground flex items-center gap-1.5 text-[11px]">
        {icon}
        {label}
      </span>
      <span className={tone ?? 'text-emma-text'}>
        <span className="text-xl font-semibold">{value}</span>
      </span>
    </PanelLink>
  )
}
