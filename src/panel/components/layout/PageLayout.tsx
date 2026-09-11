import { useMe } from '../../hooks/useMeta.js'
import { usePanelSync } from '../../hooks/usePanelSync.js'
import { Header } from './Header.js'
import { Sidebar } from './Sidebar.js'

/**
 * The shell every panel screen renders inside.
 *
 * usePanelSync lives here rather than in the inbox so the polling survives the
 * owner walking over to Citas and back — the inbox stays fresh in the cache
 * instead of reloading from scratch each time they return to it.
 *
 * `h-dvh` rather than `h-screen`: on mobile Safari `100vh` includes the address
 * bar, so the reply input sits under it and cannot be tapped.
 */
export function PageLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { data: me } = useMe()
  usePanelSync()

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-emma-bg text-emma-text">
      <Header businessName={me?.name} />
      <div className="flex min-h-0 flex-1 flex-col-reverse md:flex-row">
        <Sidebar niche={me?.niche} />
        {/* The gutter every screen sits in. Holding it here rather than inside
            each page is what keeps the blocks lined up: a page cannot drift to
            its own padding, and one number moves all four screens. */}
        <main className="min-h-0 min-w-0 flex-1 p-3">{children}</main>
      </div>
    </div>
  )
}
