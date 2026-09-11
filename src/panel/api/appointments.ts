import { apiGet, apiSend, type PanelSession } from './client.js'
import type { AppointmentActionResult, AppointmentsResponse } from './types.js'

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
