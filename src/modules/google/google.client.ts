import { env } from '@/config/env.js'
import { google } from 'googleapis'

// googleapis ships its own bundled google-auth-library; the OAuth2Client type
// exported from the top-level google-auth-library has a separate declaration
// of some private fields and can't be assigned across boundaries. We use the
// inferred constructor type so calls into google.oauth2 / google.calendar
// stay consistent.
type OAuth2Client = InstanceType<typeof google.auth.OAuth2>

const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
]

function requireOAuthConfig(): { clientId: string; clientSecret: string; redirectUri: string } {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error(
      'Google OAuth not configured: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env',
    )
  }
  return {
    clientId: env.GOOGLE_CLIENT_ID,
    clientSecret: env.GOOGLE_CLIENT_SECRET,
    redirectUri: env.GOOGLE_REDIRECT_URI,
  }
}

export function makeOAuthClient(): OAuth2Client {
  const cfg = requireOAuthConfig()
  return new google.auth.OAuth2(cfg.clientId, cfg.clientSecret, cfg.redirectUri)
}

export function getAuthUrl(state: string): string {
  const client = makeOAuthClient()
  return client.generateAuthUrl({
    // `offline` is what causes Google to also return a refresh_token so we
    // can keep using the account after the access_token expires.
    access_type: 'offline',
    // `consent` forces Google to re-show the consent screen on every connect,
    // which is what makes them re-issue the refresh_token in dev. Without
    // this, a second OAuth round won't return refresh_token.
    prompt: 'consent',
    scope: OAUTH_SCOPES,
    state,
    include_granted_scopes: true,
  })
}

export interface ExchangedTokens {
  accessToken: string
  refreshToken: string
  expiryDate: Date
}

export async function exchangeCodeForTokens(code: string): Promise<ExchangedTokens> {
  const client = makeOAuthClient()
  const { tokens } = await client.getToken(code)
  if (!tokens.access_token) throw new Error('google did not return access_token')
  if (!tokens.refresh_token) {
    throw new Error(
      'google did not return refresh_token — revoke app access in your Google account settings and try again',
    )
  }
  if (typeof tokens.expiry_date !== 'number') {
    throw new Error('google did not return expiry_date')
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiryDate: new Date(tokens.expiry_date),
  }
}

export async function getUserEmail(accessToken: string): Promise<string> {
  const client = makeOAuthClient()
  client.setCredentials({ access_token: accessToken })
  const oauth2 = google.oauth2({ version: 'v2', auth: client })
  const { data } = await oauth2.userinfo.get()
  if (!data.email) throw new Error('google userinfo did not return an email')
  return data.email
}

export interface RefreshedAccessToken {
  accessToken: string
  expiryDate: Date
}

export async function refreshAccessToken(refreshToken: string): Promise<RefreshedAccessToken> {
  const client = makeOAuthClient()
  client.setCredentials({ refresh_token: refreshToken })
  const { credentials } = await client.refreshAccessToken()
  if (!credentials.access_token) {
    throw new Error('google refresh did not return access_token')
  }
  if (typeof credentials.expiry_date !== 'number') {
    throw new Error('google refresh did not return expiry_date')
  }
  return {
    accessToken: credentials.access_token,
    expiryDate: new Date(credentials.expiry_date),
  }
}

export interface InsertEventParams {
  accessToken: string
  calendarId: string
  summary: string
  description: string
  startDateTime: Date
  durationMinutes: number
  timezone: string
  attendeeEmail?: string
}

export interface InsertedEvent {
  googleEventId: string
  htmlLink: string
}

export async function insertCalendarEvent(params: InsertEventParams): Promise<InsertedEvent> {
  const client = makeOAuthClient()
  client.setCredentials({ access_token: params.accessToken })
  const calendar = google.calendar({ version: 'v3', auth: client })

  const endDateTime = new Date(
    params.startDateTime.getTime() + params.durationMinutes * 60_000,
  )

  // googleapis types `events.insert` with multiple overloads; one is the
  // callback variant returning void, which TS sometimes picks when nothing
  // disambiguates the call. Passing the empty MethodOptions as a second
  // argument forces the params+options overload, which returns the typed
  // Gaxios response we actually need.
  const response = await calendar.events.insert(
    {
      calendarId: params.calendarId,
      requestBody: {
        summary: params.summary,
        description: params.description,
        start: {
          dateTime: params.startDateTime.toISOString(),
          timeZone: params.timezone,
        },
        end: {
          dateTime: endDateTime.toISOString(),
          timeZone: params.timezone,
        },
        attendees: params.attendeeEmail ? [{ email: params.attendeeEmail }] : undefined,
      },
    },
    {},
  )

  const eventId = response.data.id
  const htmlLink = response.data.htmlLink
  if (!eventId || !htmlLink) {
    throw new Error('google events.insert did not return id or htmlLink')
  }
  return { googleEventId: eventId, htmlLink }
}

export async function cancelCalendarEvent(
  accessToken: string,
  calendarId: string,
  googleEventId: string,
): Promise<void> {
  const client = makeOAuthClient()
  client.setCredentials({ access_token: accessToken })
  const calendar = google.calendar({ version: 'v3', auth: client })
  await calendar.events.delete({ calendarId, eventId: googleEventId })
}
