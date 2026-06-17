import { AppError, NotConnectedError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as googleClient from './google.client.js'
import * as googleCredentialsService from './googleCredentials.service.js'

export interface CreateEventParams {
  businessId: string
  summary: string
  description: string
  startDateTime: Date
  durationMinutes: number
  timezone: string
  attendeeEmail?: string
}

export interface CreateEventResult {
  googleEventId: string
  htmlLink: string
}

export async function createEvent(
  params: CreateEventParams,
): Promise<Result<CreateEventResult>> {
  const tokenResult = await googleCredentialsService.getValidAccessToken(params.businessId)
  if (!tokenResult.ok) {
    // NotConnectedError propagates as-is so callers can pattern-match on it
    // and decide whether to fail soft (the appointment bookFlow does) or hard.
    return tokenResult
  }

  try {
    const event = await googleClient.insertCalendarEvent({
      accessToken: tokenResult.data.accessToken,
      calendarId: tokenResult.data.calendarId,
      summary: params.summary,
      description: params.description,
      startDateTime: params.startDateTime,
      durationMinutes: params.durationMinutes,
      timezone: params.timezone,
      attendeeEmail: params.attendeeEmail,
    })
    return ok(event)
  } catch (cause) {
    return err(
      new AppError({
        code: 'google_create_event_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude crear el evento en Google Calendar.',
        logContext: {
          businessId: params.businessId,
          startDateTime: params.startDateTime.toISOString(),
        },
        cause,
      }),
    )
  }
}

export async function cancelEvent(
  businessId: string,
  googleEventId: string,
): Promise<Result<void>> {
  const tokenResult = await googleCredentialsService.getValidAccessToken(businessId)
  if (!tokenResult.ok) return tokenResult

  try {
    await googleClient.cancelCalendarEvent(
      tokenResult.data.accessToken,
      tokenResult.data.calendarId,
      googleEventId,
    )
    return ok(undefined)
  } catch (cause) {
    return err(
      new AppError({
        code: 'google_cancel_event_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pude cancelar el evento en Google Calendar.',
        logContext: { businessId, googleEventId },
        cause,
      }),
    )
  }
}

// Re-export for callers that need to distinguish the "not connected" case
// without importing from @/shared/errors directly.
export { NotConnectedError }
