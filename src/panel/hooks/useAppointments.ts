import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  approveAppointment,
  cancelAppointment,
  completeAppointment,
  type DateRange,
  getAppointments,
  rejectAppointment,
} from '../api/appointments.js'
import type { AppointmentActionResult, AppointmentsResponse } from '../api/types.js'
import { POLL_MS } from '../lib/constants.js'
import { useSession } from '../lib/session.js'

/**
 * The appointments in whatever range the calendar is showing.
 *
 * `range` is null until FullCalendar reports its first view, so the query waits
 * rather than guessing a week and throwing the result away.
 */
export function useAppointments(range: DateRange | null) {
  const session = useSession()

  return useQuery<AppointmentsResponse>({
    queryKey: ['appointments', session.businessId, range?.from ?? '', range?.to ?? ''],
    // enabled keeps this from running with a null range; the throw is what
    // convinces the type checker of the same thing.
    queryFn: () => {
      if (!range) throw new Error('useAppointments: query ran without a range')
      return getAppointments(session, range)
    },
    enabled: range !== null,
    refetchInterval: POLL_MS.appointments,
  })
}

// A zero-width range: the response's `data` is empty and only pendingCount is
// read. The count is business-wide, so asking for a wide range to obtain it
// would transfer a month of appointments to render one number in the nav.
const NO_RANGE: DateRange = (() => {
  const now = new Date().toISOString()
  return { from: now, to: now }
})()

/** Drives the badge in the sidebar. Lives outside the calendar, so it polls on its own. */
export function usePendingAppointmentCount(): number {
  const session = useSession()

  const { data } = useQuery({
    queryKey: ['appointments-pending', session.businessId],
    queryFn: () => getAppointments(session, NO_RANGE),
    refetchInterval: POLL_MS.appointments,
    select: (response: AppointmentsResponse) => response.pendingCount,
  })

  return data ?? 0
}

export type AppointmentAction = 'approve' | 'reject' | 'cancel' | 'complete'

export interface AppointmentActionVars {
  id: string
  action: AppointmentAction
  reason?: string
}

/**
 * The four actions as one mutation.
 *
 * Every one of them ends the same way — the row's status changed and both the
 * calendar and the pending badge are now stale — so they share an invalidation
 * rather than four copies of it.
 */
export function useAppointmentAction() {
  const session = useSession()
  const queryClient = useQueryClient()

  return useMutation<AppointmentActionResult, Error, AppointmentActionVars>({
    mutationFn: ({ id, action, reason }) => {
      if (action === 'approve') return approveAppointment(session, id)
      if (action === 'complete') return completeAppointment(session, id)
      if (action === 'reject') return rejectAppointment(session, id, reason)
      return cancelAppointment(session, id, reason)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['appointments', session.businessId] })
      void queryClient.invalidateQueries({ queryKey: ['appointments-pending', session.businessId] })
      // A booking that just got approved or rejected also moves the
      // conversation's qualification, which the inbox is showing.
      void queryClient.invalidateQueries({ queryKey: ['conversations', session.businessId] })
    },
  })
}
