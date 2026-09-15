import { apiGet, apiSend, type PanelSession } from './client.js'
import type {
  AppointmentActionResult,
  AppointmentsResponse,
  CreateAppointmentPayload,
  CreateAppointmentResult,
} from './types.js'

export interface DateRange {
  /** ISO 8601 in UTC. FullCalendar hands out local Dates; the caller converts. */
  from: string
  to: string
}

export function getAppointments(
  session: PanelSession,
  range: DateRange,
): Promise<AppointmentsResponse> {
  return apiGet<AppointmentsResponse>(session, '/appointments', {
    from: range.from,
    to: range.to,
  })
}

/**
 * Books an appointment the owner entered by hand.
 *
 * A slot that breaks a rule comes back as `created: false` with the warnings,
 * not as a thrown `PanelApiError` — see `CreateAppointmentResult`.
 */
export function createAppointment(
  session: PanelSession,
  payload: CreateAppointmentPayload,
): Promise<CreateAppointmentResult> {
  return apiSend<CreateAppointmentResult>(session, 'POST', '/appointments', payload)
}

export function approveAppointment(
  session: PanelSession,
  id: string,
): Promise<AppointmentActionResult> {
  return apiSend<AppointmentActionResult>(session, 'PATCH', `/appointments/${id}/approve`)
}

export function rejectAppointment(
  session: PanelSession,
  id: string,
  reason?: string,
): Promise<AppointmentActionResult> {
  return apiSend<AppointmentActionResult>(session, 'PATCH', `/appointments/${id}/reject`, {
    ...(reason ? { reason } : {}),
  })
}

export function cancelAppointment(
  session: PanelSession,
  id: string,
  reason?: string,
): Promise<AppointmentActionResult> {
  return apiSend<AppointmentActionResult>(session, 'PATCH', `/appointments/${id}/cancel`, {
    ...(reason ? { reason } : {}),
  })
}

export function completeAppointment(
  session: PanelSession,
  id: string,
): Promise<AppointmentActionResult> {
  return apiSend<AppointmentActionResult>(session, 'PATCH', `/appointments/${id}/complete`)
}
