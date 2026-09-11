import { useState } from 'react'
import type { DateRange } from '../api/appointments.js'
import type { PanelAppointment } from '../api/types.js'
import { AppointmentCalendar } from '../components/appointments/AppointmentCalendar.js'
import { AppointmentDetail } from '../components/appointments/AppointmentDetail.js'
import { useAppointments } from '../hooks/useAppointments.js'
import { useMe } from '../hooks/useMeta.js'
import { nicheCopy } from '../lib/constants.js'

/**
 * The appointments calendar (US-07).
 *
 * The visible range is owned here rather than by the query: FullCalendar
 * decides what it is showing, reports it through datesSet, and the fetch
 * follows. Paging to next week is therefore one state change and one refetch,
 * with no duplicate idea of "current week" to keep in sync.
 */
export function AppointmentsPage(): React.JSX.Element {
  const { data: me } = useMe()
  const copy = nicheCopy(me?.niche)

  const [range, setRange] = useState<DateRange | null>(null)
  const [selected, setSelected] = useState<PanelAppointment | null>(null)

  const { data, isError } = useAppointments(range)
  const appointments = data?.data ?? []

  return (
    <div className="bg-emma-bg-secondary border-border flex h-full min-h-0 flex-col overflow-hidden rounded-xl border">
      <header className="flex shrink-0 items-baseline justify-between gap-3 border-b border-border px-4 py-3">
        <h1 className="text-base font-semibold text-emma-text">{copy.appointmentsLabel}</h1>
        {isError && <p className="text-destructive text-xs">No pudimos cargar la agenda.</p>}
      </header>

      <div className="emma-calendar min-h-0 flex-1 overflow-y-auto p-3">
        <AppointmentCalendar
          appointments={appointments}
          operatingHours={me?.operatingHours ?? null}
          onRangeChange={setRange}
          onSelect={setSelected}
        />
      </div>

      <AppointmentDetail
        appointment={selected}
        contactsLabel={copy.contactsLabel}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}
