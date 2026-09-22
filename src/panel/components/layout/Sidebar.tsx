import { Bot, CalendarDays, LayoutDashboard, MessageSquare, Settings, Wrench } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { usePendingAppointmentCount } from '../../hooks/useAppointments.js'
import { type NicheCopy, nicheCopy } from '../../lib/constants.js'
import { PanelLink } from '../../lib/session.js'
import { cn } from '../../lib/utils.js'
import { Badge } from '../ui/badge.js'

interface NavItem {
  to: string
  label: (copy: NicheCopy) => string
  icon: typeof MessageSquare
  /** Appointments waiting on the owner's decision, per US-07 AC6. */
  showsPending?: boolean
}

const NAV: NavItem[] = [
  { to: '/', label: () => 'Inbox', icon: MessageSquare },
  { to: '/dashboard', label: () => 'Dashboard', icon: LayoutDashboard },
  { to: '/citas', label: (copy) => copy.appointmentsLabel, icon: CalendarDays, showsPending: true },
  { to: '/servicios', label: () => 'Servicios', icon: Wrench },
  { to: '/asistente', label: () => 'Asistente', icon: Bot },
  { to: '/configuracion', label: () => 'Configuración', icon: Settings },
]

export function Sidebar({
  niche,
  booksAppointments = true,
}: {
  niche: string | undefined
  /** Defaults to true so the nav never loses an entry while /me is in flight. */
  booksAppointments?: boolean
}): React.JSX.Element {
  const copy = nicheCopy(niche)
  const items = booksAppointments ? NAV : NAV.filter((item) => item.to !== '/citas')
  const { pathname } = useLocation()
  const pending = usePendingAppointmentCount()

  // The business id is the first segment, so the section is what follows it.
  const section = `/${pathname.split('/').slice(2).join('/')}`.replace(/\/$/, '') || '/'

  return (
    <nav
      aria-label="Secciones"
      className={cn(
        // Same near-black as the page, so the rail is defined by the rule along
        // its edge and by the green of the active item — not by a second shade
        // competing with the content blocks.
        'bg-emma-sidebar border-emma-sidebar-border flex shrink-0 gap-1',
        // Horizontal bar on phones, rail on desktop. One element, not two
        // components fighting over which is mounted. On a phone it sits last,
        // under the content; on desktop it is the body of the left column, so
        // the width and the rule down its edge belong to that column and not
        // here — otherwise the header above it would stop short of both.
        'order-3 flex-row border-t p-2',
        'md:order-none md:min-h-0 md:flex-1 md:flex-col md:border-t-0 md:p-3',
      )}
    >
      {items.map((item) => {
        const active = section === item.to
        const Icon = item.icon
        return (
          <PanelLink
            key={item.to}
            to={item.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm transition-colors md:flex-none md:justify-start',
              active
                ? 'bg-emma-accent font-medium text-white'
                : 'text-emma-sidebar-text/75 hover:bg-emma-cream/10 hover:text-emma-cream',
            )}
          >
            <Icon size={18} aria-hidden />
            <span className="hidden md:inline">{item.label(copy)}</span>
            {item.showsPending && pending > 0 && (
              // Two placements, one element. On desktop the label is visible and
              // the count sits at the end of the row. On a phone the label is
              // hidden, so `ml-auto` would shove the count to the edge of the
              // item and drag the icon off centre with it — there it pins to the
              // icon instead.
              <Badge
                variant="secondary"
                className="bg-q-needs-info/20 text-q-needs-info absolute top-0.5 left-1/2 translate-x-1 rounded-full px-1 text-[10px] md:static md:ml-auto md:translate-x-0 md:px-1.5 md:text-xs"
                aria-label={`${pending} pendientes`}
              >
                {pending}
              </Badge>
            )}
          </PanelLink>
        )
      })}
    </nav>
  )
}
