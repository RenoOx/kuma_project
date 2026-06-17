import { logger } from '@/config/logger.js'
import { AppError, NotConnectedError } from '@/shared/errors.js'
import { err, ok, type Result } from '@/shared/result.js'
import * as googleClient from './google.client.js'
import * as googleCredentialsRepo from './googleCredentials.repo.js'

// Refresh the token a couple of minutes before it actually expires so the
// caller never has to deal with mid-flight expiry.
const REFRESH_THRESHOLD_MS = 2 * 60 * 1000

export interface ValidAccessToken {
  accessToken: string
  calendarId: string
}

export async function getValidAccessToken(
  businessId: string,
): Promise<Result<ValidAccessToken>> {
  try {
    const creds = await googleCredentialsRepo.findByBusiness(businessId)
    if (!creds) {
      return err(
        new NotConnectedError({
          businessId,
          service: 'google_calendar',
          userMessage: 'Este negocio aún no vinculó su Google Calendar.',
        }),
      )
    }

    const msUntilExpiry = creds.tokenExpiresAt.getTime() - Date.now()
    if (msUntilExpiry > REFRESH_THRESHOLD_MS) {
      return ok({ accessToken: creds.accessToken, calendarId: creds.calendarId })
    }

    // Need to refresh.
    logger.info(
      { businessId, msUntilExpiry },
      'google access_token close to expiry, refreshing',
    )
    const refreshed = await googleClient.refreshAccessToken(creds.refreshToken)
    const updated = await googleCredentialsRepo.updateTokens(businessId, {
      accessToken: refreshed.accessToken,
      tokenExpiresAt: refreshed.expiryDate,
    })
    return ok({ accessToken: updated.accessToken, calendarId: updated.calendarId })
  } catch (cause) {
    return err(
      new AppError({
        code: 'google_get_access_token_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos contactar Google Calendar.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}

export async function disconnect(businessId: string): Promise<Result<void>> {
  try {
    await googleCredentialsRepo.deleteByBusiness(businessId)
    return ok(undefined)
  } catch (cause) {
    return err(
      new AppError({
        code: 'google_disconnect_failed',
        message: cause instanceof Error ? cause.message : 'unknown error',
        userMessage: 'No pudimos desvincular Google Calendar.',
        logContext: { businessId },
        cause,
      }),
    )
  }
}
