import type { DateSelectArg, EventClickArg, EventInput } from '@fullcalendar/core'
import esLocale from '@fullcalendar/core/locales/es'
import dayGridPlugin from '@fullcalendar/daygrid'
import interactionPlugin from '@fullcalendar/interaction'
import listPlugin from '@fullcalendar/list'
import FullCalendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/timegrid'
import { useEffect, useRef } from 'react'
import type { DateRange } from '../../api/appointments.js'
import type { OperatingHours, PanelAppointment } from '../../api/types.js'
import { useIsDesktop } from '../../hooks/useMediaQuery.js'
import { APPOINTMENT_META, DAY_KEYS } from '../../lib/constants.js'

interface BusinessHour {
  daysOfWeek: number[]
  startTime: string
  endTime: string
}

/**
 * The weekly schedule, in FullCalendar's vocabulary.
 *
 * A day with a break becomes two entries rather than one: the break is time the
 * business is closed, and drawing straight through it would shade the lunch
 * hour as bookable. Returns undefined for a business with no settings, which
 * FullCalendar renders as no shading at all — better than inventing hours.
 */
function toBusinessHours(hours: OperatingHours | null): BusinessHour[] | undefined {
  if (!hours) return undefined

  const result: BusinessHour[] = []
  DAY_KEYS.forEach((key, index) => {
    const day = hours[key]
    if (!day) return
    // DAY_KEYS is Monday-first for reading; FullCalendar counts from Sunday.
    const dow = (index + 1) % 7
    if (day.break) {
      result.push({ daysOfWeek: [dow], startTime: day.open, endTime: day.break.start })
      result.push({ daysOfWeek: [dow], startTime: day.break.end, endTime: day.close })
      return
    }
    result.push({ daysOfWeek: [dow], startTime: day.open, endTime: day.close })
  })
  return result
}

export function AppointmentCalendar({
  appointments,
  operatingHours,
  onRangeChange,
  onSelect,
  onSlotClick,
}: {
  appointments: PanelAppointment[]
  operatingHours: OperatingHours | null
  onRangeChange: (range: DateRange) => void
  onSelect: (appointment: PanelAppointment) => void
  /** An empty slot the owner picked, as wall-clock YYYY-MM-DD and HH:mm. */
  onSlotClick: (date: string, time: string) => void
}): React.JSX.Element {
  const isDesktop = useIsDesktop()
  const calendarRef = useRef<FullCalendar>(null)

  // A seven-column time grid on a 390px screen is unreadable, so a phone opens
  // on the agenda list instead. The switch goes through the imperative API
  // rather than a remount keyed on width: changeView keeps the date the owner
  // was looking at, while a remount would throw them back to today.
  useEffect(() => {
    calendarRef.current?.getApi().changeView(isDesktop ? 'timeGridWeek' : 'listWeek')
  }, [isDesktop])

  const events: EventInput[] = appointments.map((appointment) => {
    const start = new Date(appointment.scheduledAt)
    const end = new Date(start.getTime() + appointment.durationMinutes * 60_000)
    const meta = APPOINTMENT_META[appointment.status]
    return {
      id: appointment.id,
      title: `${appointment.customerName ?? appointment.customerPhone} — ${appointment.service}`,
      start,
      end,
      backgroundColor: meta.color,
      borderColor: meta.color,
      textColor: '#ffffff',
    }
  })

  // Looked up by id rather than carried in extendedProps: FullCalendar types
  // that bag as a loose dictionary, and reading the appointment back out of it
  // would mean casting away the type this component already has in hand.
  const handleClick = (info: EventClickArg): void => {
    const clicked = appointments.find((appointment) => appointment.id === info.event.id)
    if (clicked) onSelect(clicked)
  }

  // The gesture the owner tries anyway: click an empty slot to book it. Read
  // off the local Date rather than the ISO string, which is UTC and lands on
  // the wrong day in Lima all evening.
  const handleSelect = (info: DateSelectArg): void => {
    const pad = (n: number): string => `${n}`.padStart(2, '0')
    const d = info.start
    onSlotClick(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    )
    info.view.calendar.unselect()
  }

  return (
    <FullCalendar
      ref={calendarRef}
      plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin, listPlugin]}
      initialView={isDesktop ? 'timeGridWeek' : 'listWeek'}
      locale={esLocale}
      headerToolbar={{
        left: 'prev,next today',
        center: 'title',
        // Four view buttons do not fit on a phone; the two that make sense
        // there do.
        right: isDesktop
          ? 'timeGridDay,timeGridWeek,dayGridMonth,listWeek'
          : 'listWeek,dayGridMonth',
      }}
      events={events}
      eventClick={handleClick}
      selectable
      select={handleSelect}
      // Dates arrive as local Date objects; the API validates strict ISO with a
      // Z, so the conversion happens here rather than in every caller.
      datesSet={(info) =>
        onRangeChange({ from: info.start.toISOString(), to: info.end.toISOString() })
      }
      businessHours={toBusinessHours(operatingHours)}
      slotMinTime="07:00:00"
      slotMaxTime="21:00:00"
      allDaySlot={false}
      nowIndicator
      // "auto" rather than a fixed height: the page scrolls the calendar, so a
      // week view shows its full 07:00-21:00 span instead of squeezing fourteen
      // hours into whatever is left below the toolbar on a phone.
      height="auto"
      stickyHeaderDates
      dayMaxEvents
    />
  )
}
