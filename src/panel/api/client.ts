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
    /**
     * The server's `message`, which is an AppError's userMessage — the field
     * built to be safe to show. Optional because not every error shape carries
     * one; a caller that wants to render it has to handle its absence.
     */
    readonly userMessage?: string,
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
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string }
    throw new PanelApiError(res.status, body.error ?? 'unknown_error', body.message)
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

/**
 * Multipart upload of a single file, under the field name `file`.
 *
 * No content-type header on purpose: the browser writes it with the boundary it
 * generated for this body, and setting it by hand produces a request the server
 * cannot parse even though it looks correct.
 */
export async function apiUpload<T>(session: PanelSession, path: string, file: File): Promise<T> {
  const body = new FormData()
  body.set('file', file)
  const res = await fetch(buildUrl(session, path), { method: 'POST', body })
  return await parse<T>(res)
}

export async function apiSend<T>(
  session: PanelSession,
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(buildUrl(session, path), {
    method,
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    // DELETE carries no body. Some proxies drop a request body on DELETE and
    // others reject it outright, so the header/body pair is simply omitted
    // rather than sent as an empty object nobody reads.
    ...(method === 'DELETE' ? {} : { body: JSON.stringify(body ?? {}) }),
  })
  return await parse<T>(res)
}
