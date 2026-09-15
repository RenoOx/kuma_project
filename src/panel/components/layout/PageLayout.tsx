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
    <div className="flex h-dvh flex-col overflow-hidden bg-emma-bg text-emma-text md:flex-row">
      {/* The left column on desktop: the header sits ON the rail rather than
          across the whole window, so the 52px band it used to take out of the
          full width goes back to the content beside it.

          `contents` on phones drops this wrapper out of the flow entirely, so
          the header and the nav stay direct children of the vertical shell and
          keep their own places — header at the top, nav bar at the bottom, set
          by `order` on each. One DOM for both shapes, the way the nav itself
          already flips its axis instead of mounting a second component. */}
      <div className="contents md:flex md:w-52 md:shrink-0 md:flex-col md:border-r md:border-emma-sidebar-border">
        <Header businessName={me?.name} />
        <Sidebar niche={me?.niche} />
      </div>
      {/* The gutter every screen sits in. Holding it here rather than inside
          each page is what keeps the blocks lined up: a page cannot drift to
          its own padding, and one number moves all four screens. */}
      <main className="order-2 min-h-0 min-w-0 flex-1 p-3 md:order-none">{children}</main>
    </div>
  )
}
