import { useHealth } from '../../hooks/useMeta.js'
import { cn } from '../../lib/utils.js'
import { Logo } from './Logo.js'

/**
 * Who this panel belongs to, and whether Emma is up.
 *
 * Two shapes, one element. On a phone it is a 52px bar across the top, name on
 * the left and status on the right. On desktop it caps the rail instead: the
 * same information stacked inside 208px, because a full-width band spent 52px
 * of every screen on two short strings and took them from the content.
 *
 * It carries the wordmark on desktop — it now occupies the spot the nav used to
 * put the logo in, and two marks stacked against each other is one too many.
 * Height is fixed on the phone bar and automatic on the rail: "Emma
 * desconectada hace 12 min" does not fit beside the name in 208px.
 */
export function Header({ businessName }: { businessName: string | undefined }): React.JSX.Element {
  return (
    <header
      className={cn(
        'order-1 flex shrink-0 gap-3 border-b border-emma-border bg-emma-bg md:order-none',
        'h-13 items-center justify-between px-4',
        // On desktop it is the top of the rail, not a band over the page, so it
        // takes the rail's surface and its border — otherwise the left column
        // reads as two stacked panels, cream over near-black.
        'md:border-emma-sidebar-border md:bg-emma-sidebar',
        'md:h-auto md:flex-col md:items-start md:gap-2 md:px-3 md:pt-3 md:pb-4',
      )}
    >
      <div className="hidden md:block">
        <Logo />
      </div>
      <h1 className="text-emma-text md:text-emma-sidebar-text truncate text-sm font-semibold md:w-full">
        {businessName ?? 'Panel Emma'}
      </h1>
      <ConnectionIndicator />
    </header>
  )
}

/**
 * Whether Emma's WhatsApp number is online, polled every 30s.
 *
 * Reads the server's in-memory client registry, so with more than one instance
 * this becomes "connected on whichever instance answered" — the same caveat
 * clientRegistry already carries. One container today, which makes it true.
 */
function ConnectionIndicator(): React.JSX.Element {
  const { data, isLoading, isError } = useHealth()

  if (isLoading || isError || !data) {
    return <Pill tone="unknown" full="Emma —" short="—" />
  }
  if (data.connected) {
    return <Pill tone="up" full="Emma conectada" short="Conectada" />
  }
  return (
    <Pill tone="down" full={`Emma desconectada${downFor(data.downSince)}`} short="Desconectada" />
  )
}

/** " hace 12 minutos", or nothing when the server did not say since when. */
function downFor(downSince: string | undefined): string {
  if (!downSince) return ''
  const since = new Date(downSince).getTime()
  if (Number.isNaN(since)) return ''

  const minutes = Math.floor((Date.now() - since) / 60_000)
  if (minutes < 1) return ' recién'
  if (minutes < 60) return ` hace ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return ` hace ${hours}h`
  return ` hace ${Math.floor(hours / 24)}d`
}

/**
 * Two lengths of the same status, picked by the space available.
 *
 * The phone bar runs the width of the screen, so it says the whole thing —
 * "Emma desconectada hace 12 min", which is the version that tells the owner
 * whether this just happened or has been true all morning. The rail has 208px
 * and the badge was pushing out of it, so there it drops to one word: the dot
 * already carries "Emma", and the full text stays one hover away in `title`.
 *
 * `hidden` is display:none, so a screen reader is read exactly one of the two —
 * never both.
 */
function Pill({
  tone,
  full,
  short,
}: {
  tone: 'up' | 'down' | 'unknown'
  full: string
  short: string
}): React.JSX.Element {
  return (
    <span
      // A colour alone would say nothing to a screen reader, and this is the
      // one status on screen that changes without the owner doing anything.
      role="status"
      title={full}
      className={cn(
        'flex max-w-full shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs whitespace-nowrap',
        tone === 'up' && 'bg-q-qualified/15 text-q-qualified',
        tone === 'down' && 'bg-q-lost/15 text-q-lost',
        tone === 'unknown' && 'bg-secondary text-emma-text-muted',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          tone === 'up' && 'bg-q-qualified',
          tone === 'down' && 'bg-q-lost',
          tone === 'unknown' && 'bg-emma-text-muted',
        )}
      />
      <span className="truncate md:hidden">{full}</span>
      <span className="hidden truncate md:inline">{short}</span>
    </span>
  )
}
