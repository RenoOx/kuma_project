import { Plus } from 'lucide-react'
import { useState } from 'react'
import type { DateRange } from '../api/appointments.js'
import type { PanelAppointment } from '../api/types.js'
import { AppointmentCalendar } from '../components/appointments/AppointmentCalendar.js'
import { AppointmentDetail } from '../components/appointments/AppointmentDetail.js'
import {
  AppointmentFilters,
  filterAppointments,
  useAppointmentFilter,
} from '../components/appointments/AppointmentFilters.js'
import { CreateAppointmentModal } from '../components/appointments/CreateAppointmentModal.js'
import { Button } from '../components/ui/button.js'
import { useAppointments } from '../hooks/useAppointments.js'
import { useMe } from '../hooks/useMeta.js'
import { nicheCopy } from '../lib/constants.js'

/**
 * The appointments calendar (US-07) and the form that books one by hand.
 *
 * The visible range is owned here rather than by the query: FullCalendar
 * decides what it is showing, reports it through datesSet, and the fetch
 * follows. Paging to next week is therefore one state change and one refetch,
 * with no duplicate idea of "current week" to keep in sync.
 *
 * The status filter runs over the fetched array instead of the query: the range
 * is already loaded, so filtering it is free and refetching it would not be.
 */
export function AppointmentsPage(): React.JSX.Element {
  const { data: me } = useMe()
  const copy = nicheCopy(me?.niche)

  const [range, setRange] = useState<DateRange | null>(null)
  const [selected, setSelected] = useState<PanelAppointment | null>(null)
  // An object rather than a boolean: it carries the slot the owner clicked on
  // the calendar, and doubles as the modal's remount key so a cancelled form
  // does not reopen half-filled.
  const [creating, setCreating] = useState<{ date?: string; time?: string } | null>(null)

  const filter = useAppointmentFilter()
  const { data, isError } = useAppointments(range)
  const appointments = filterAppointments(data?.data ?? [], filter)

  return (
    <div className="bg-emma-bg-secondary border-border flex h-full min-h-0 flex-col overflow-hidden rounded-xl border">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h1 className="text-base font-semibold text-emma-text">{copy.appointmentsLabel}</h1>
        <div className="flex min-w-0 items-center gap-3">
          {isError && <p className="text-destructive text-xs">No pudimos cargar la agenda.</p>}
          <AppointmentFilters />
          <Button variant="outline" size="sm" onClick={() => setCreating({})}>
            <Plus size={14} aria-hidden />
            Nueva cita
          </Button>
        </div>
      </header>

      <div className="emma-calendar min-h-0 flex-1 overflow-y-auto p-3">
        <AppointmentCalendar
          appointments={appointments}
          operatingHours={me?.operatingHours ?? null}
          onRangeChange={setRange}
          onSelect={setSelected}
          onSlotClick={(date, time) => setCreating({ date, time })}
        />
      </div>

      <AppointmentDetail
        appointment={selected}
        contactsLabel={copy.contactsLabel}
        onClose={() => setSelected(null)}
      />

      {creating !== null && (
        <CreateAppointmentModal
          key={`${creating.date ?? ''}T${creating.time ?? ''}`}
          open
          onClose={() => setCreating(null)}
          {...(creating.date ? { initialDate: creating.date } : {})}
          {...(creating.time ? { initialTime: creating.time } : {})}
        />
      )}
    </div>
  )
}
