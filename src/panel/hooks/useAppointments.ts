import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  approveAppointment,
  cancelAppointment,
  completeAppointment,
  createAppointment,
  type DateRange,
  getAppointments,
  rejectAppointment,
} from '../api/appointments.js'
import { PanelApiError } from '../api/client.js'
import type {
  AppointmentActionResult,
  AppointmentsResponse,
  CreateAppointmentPayload,
  CreateAppointmentResult,
} from '../api/types.js'
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

export interface CreateAppointmentMutation {
  create: (payload: CreateAppointmentPayload) => void
  saving: boolean
  error: string | null
}

/**
 * The owner booking someone by hand.
 *
 * Only the branch that actually created a row invalidates: a response full of
 * warnings changed nothing on the server, and refetching the calendar to show
 * the same appointments would make the modal flicker for no reason.
 *
 * `onCreated` carries the result so the caller can tell the two branches apart —
 * close the modal, or show what the slot breaks.
 */
export function useCreateAppointment(
  onCreated: (result: CreateAppointmentResult) => void,
): CreateAppointmentMutation {
  const session = useSession()
  const queryClient = useQueryClient()

  const mutation = useMutation<CreateAppointmentResult, Error, CreateAppointmentPayload>({
    mutationFn: (payload) => createAppointment(session, payload),
    onSuccess: (result) => {
      if (result.created) {
        void queryClient.invalidateQueries({ queryKey: ['appointments', session.businessId] })
        void queryClient.invalidateQueries({
          queryKey: ['appointments-pending', session.businessId],
        })
        // Booking a phone-in contact creates the customer row, so the contacts
        // list is stale too — and the confirmation, when the owner asked for
        // one, lands in that customer's thread.
        void queryClient.invalidateQueries({ queryKey: ['customers', session.businessId] })
        void queryClient.invalidateQueries({ queryKey: ['conversations', session.businessId] })
      }
      onCreated(result)
    },
  })

  return {
    create: (payload) => mutation.mutate(payload),
    saving: mutation.isPending,
    error: mutation.error ? errorText(mutation.error) : null,
  }
}

function errorText(error: Error): string {
  // The server's userMessage names the rule that was hit — an unknown service,
  // a contact from another business, a phone that is not one.
  if (error instanceof PanelApiError && error.userMessage) return error.userMessage
  return 'No pudimos agendar la cita. Intentá de nuevo.'
}
