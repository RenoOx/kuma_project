import { useHealth } from '../../hooks/useMeta.js'
import { cn } from '../../lib/utils.js'

export function Header({ businessName }: { businessName: string | undefined }): React.JSX.Element {
  return (
    // A navigation bar, not a page header: 52px fixed, page-coloured, separated
    // by a rule rather than by a fill. Everything it does not take goes to the
    // content below it, which is the only thing on screen worth looking at.
    <header className="flex h-13 shrink-0 items-center justify-between gap-3 border-b border-emma-border bg-emma-bg px-4">
      <h1 className="truncate text-sm font-semibold text-emma-text">
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
    return <Pill tone="unknown" label="Emma —" />
  }
  if (data.connected) {
    return <Pill tone="up" label="Emma conectada" />
  }
  return <Pill tone="down" label={`Emma desconectada${downFor(data.downSince)}`} />
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

function Pill({
  tone,
  label,
}: {
  tone: 'up' | 'down' | 'unknown'
  label: string
}): React.JSX.Element {
  return (
    <span
      // A colour alone would say nothing to a screen reader, and this is the
      // one status on screen that changes without the owner doing anything.
      role="status"
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs whitespace-nowrap',
        tone === 'up' && 'bg-q-qualified/15 text-q-qualified',
        tone === 'down' && 'bg-q-lost/15 text-q-lost',
        tone === 'unknown' && 'bg-secondary text-emma-text-muted',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-1.5 rounded-full',
          tone === 'up' && 'bg-q-qualified',
          tone === 'down' && 'bg-q-lost',
          tone === 'unknown' && 'bg-emma-text-muted',
        )}
      />
      {label}
    </span>
  )
}
