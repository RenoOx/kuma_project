import { CalendarDays, LayoutDashboard, MessageSquare, Users } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { usePendingAppointmentCount } from '../../hooks/useAppointments.js'
import { type NicheCopy, nicheCopy } from '../../lib/constants.js'
import { PanelLink } from '../../lib/session.js'
import { cn } from '../../lib/utils.js'
import { Badge } from '../ui/badge.js'
import { Logo } from './Logo.js'

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
  { to: '/contactos', label: (copy) => copy.contactsLabel, icon: Users },
]

export function Sidebar({ niche }: { niche: string | undefined }): React.JSX.Element {
  const copy = nicheCopy(niche)
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
        'bg-emma-sidebar border-emma-border flex shrink-0 gap-1',
        // Horizontal bar on phones, rail on desktop. One element, not two
        // components fighting over which is mounted. The border follows the
        // flip: a top rule under the bar, a right rule beside the rail.
        'flex-row border-t p-2',
        'md:h-full md:w-52 md:flex-col md:border-t-0 md:border-r md:p-3',
      )}
    >
      <div className="hidden px-3 pt-1 pb-4 md:block">
        <Logo />
      </div>

      {NAV.map((item) => {
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
