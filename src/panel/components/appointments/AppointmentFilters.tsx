import { useSearchParams } from 'react-router-dom'
import { useDragScroll } from '../../hooks/useDragScroll.js'
import {
  APPOINTMENT_META,
  APPOINTMENT_STATUSES,
  type AppointmentStatus,
} from '../../lib/constants.js'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs.js'

export type AppointmentFilter = AppointmentStatus | 'all'

/**
 * Reads the active filter off the URL.
 *
 * In the URL rather than in state so a filtered agenda survives a reload and
 * can be linked to — the same reasoning as the inbox's label filter. An
 * unrecognised value falls back to "Todos" instead of an agenda that looks
 * empty for no visible reason.
 */
export function useAppointmentFilter(): AppointmentFilter {
  const [params] = useSearchParams()
  const requested = params.get('estado') ?? 'all'
  return (APPOINTMENT_STATUSES as readonly string[]).includes(requested)
    ? (requested as AppointmentStatus)
    : 'all'
}

/** Filters in the client: the calendar already has the whole range loaded. */
export function AppointmentFilters(): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  const filter = useAppointmentFilter()
  const strip = useDragScroll<HTMLDivElement>()

  const select = (next: string): void => {
    const updated = new URLSearchParams(params)
    if (next === 'all') updated.delete('estado')
    else updated.set('estado', next)
    setParams(updated, { replace: true })
  }

  return (
    <Tabs value={filter} onValueChange={select} className="min-w-0">
      <TabsList
        ref={strip.ref}
        {...strip.dragProps}
        className="no-scrollbar w-full min-w-0 flex-nowrap justify-start overflow-x-auto rounded-full"
      >
        <TabsTrigger value="all" className="flex-none rounded-full">
          Todos
        </TabsTrigger>
        {APPOINTMENT_STATUSES.map((status) => (
          <TabsTrigger key={status} value={status} className="flex-none rounded-full">
            <span
              className="size-2 rounded-full"
              style={{ backgroundColor: APPOINTMENT_META[status].color }}
              aria-hidden
            />
            {APPOINTMENT_META[status].label}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  )
}

export function filterAppointments<T extends { status: AppointmentStatus }>(
  appointments: T[],
  filter: AppointmentFilter,
): T[] {
  return filter === 'all' ? appointments : appointments.filter((a) => a.status === filter)
}
