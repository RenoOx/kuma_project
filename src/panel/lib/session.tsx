import { createContext, useContext, useMemo } from 'react'
import { Link, type LinkProps, useLocation, useParams } from 'react-router-dom'
import type { PanelSession } from '../api/client.js'

const SessionContext = createContext<PanelSession | null>(null)

export function PanelSessionProvider({
  children,
}: {
  children: (session: PanelSession) => React.ReactNode
}): React.JSX.Element {
  const { businessId } = useParams<{ businessId: string }>()
  const location = useLocation()

  const session = useMemo<PanelSession | null>(() => {
    const token = new URLSearchParams(location.search).get('token')
    if (!businessId || !token) return null
    return { businessId, token }
  }, [businessId, location.search])

  if (!session) return <InvalidLink />

  return <SessionContext.Provider value={session}>{children(session)}</SessionContext.Provider>
}

/** Only valid inside PanelSessionProvider, which refuses to render without one. */
export function useSession(): PanelSession {
  const session = useContext(SessionContext)
  if (!session) throw new Error('useSession called outside PanelSessionProvider')
  return session
}

function InvalidLink(): React.JSX.Element {
  return (
    <PanelNotice
      title="Link inválido"
      body="Este enlace no tiene un negocio o un token válido. Pedile a Vamvu Labs el link de tu panel."
    />
  )
}

/**
 * A full-screen message, for the states where there is no panel to show.
 *
 * Shared so "link inválido" and "el link dejó de funcionar" look like the same
 * product rather than two error screens written months apart.
 */
export function PanelNotice({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <h1 className="text-lg font-semibold text-emma-text">{title}</h1>
        <p className="mt-2 text-sm text-emma-text-muted">{body}</p>
      </div>
    </main>
  )
}

/**
 * A Link that keeps the panel token in the URL.
 *
 * The token IS the session — there is no cookie behind it — so a plain
 * `<Link to="/dashboard">` drops it and the next request 401s. Every internal
 * navigation goes through this; `Link` is never imported directly outside this
 * file.
 */
export function PanelLink({
  to,
  params,
  ...props
}: Omit<LinkProps, 'to'> & { to: string; params?: Record<string, string> }): React.JSX.Element {
  const session = useSession()
  return <Link to={panelHref(session, to, params)} {...props} />
}

/**
 * The same URL construction, for callers that need the string rather than a Link.
 *
 * `params` is for links that carry a filter with them — the dashboard's
 * qualification cards open the inbox already filtered, a customer's row opens
 * the inbox already searching their number. The token is set last so no caller
 * can accidentally overwrite the one thing that must survive.
 */
export function panelHref(
  session: PanelSession,
  to: string,
  params?: Record<string, string>,
): string {
  const query = new URLSearchParams(params)
  query.set('token', session.token)
  return `/${session.businessId}${to === '/' ? '' : to}?${query.toString()}`
}
