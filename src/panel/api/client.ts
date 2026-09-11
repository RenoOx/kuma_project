// Every panel request carries the same two things: which business, and the
// token that proves the caller owns it. Both live in the URL the owner opened
// (/panel/:businessId?token=…), so they are read from there once rather than
// threaded through every hook.

export interface PanelSession {
  businessId: string
  token: string
}

/**
 * Reads the session out of the current URL.
 *
 * Returns null when either half is missing, which the app renders as its own
 * "link inválido" screen — a fetch with no token would just bounce off the
 * middleware with a 401 and tell the owner nothing useful.
 */
export function readSession(pathname: string, search: string): PanelSession | null {
  const businessId = pathname.replace(/^\/panel\/?/, '').split('/')[0]
  const token = new URLSearchParams(search).get('token')
  if (!businessId || !token) return null
  return { businessId, token }
}

export class PanelApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`panel api ${status}: ${code}`)
    this.name = 'PanelApiError'
  }
}

function buildUrl(session: PanelSession, path: string, params?: Record<string, string>): string {
  const url = new URL(`/api/panel/${session.businessId}${path}`, window.location.origin)
  url.searchParams.set('token', session.token)
  for (const [key, value] of Object.entries(params ?? {})) {
    // Empty filters are absent filters. Sending `qualification=` would make the
    // backend match on the empty string instead of skipping the clause.
    if (value !== '') url.searchParams.set(key, value)
  }
  return url.toString()
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new PanelApiError(res.status, body.error ?? 'unknown_error')
  }
  return (await res.json()) as T
}

export async function apiGet<T>(
  session: PanelSession,
  path: string,
  params?: Record<string, string>,
): Promise<T> {
  const res = await fetch(buildUrl(session, path, params), {
    headers: { accept: 'application/json' },
  })
  return await parse<T>(res)
}

export async function apiSend<T>(
  session: PanelSession,
  method: 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(buildUrl(session, path), {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return await parse<T>(res)
}
