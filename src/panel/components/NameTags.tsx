import { cn } from '../lib/utils.js'

// Three fit on a phone next to the number without pushing the timestamp off the
// row. A number with more than three names behind it is a family or an office
// line, and the count says that better than a list nobody can read.
const MAX_VISIBLE = 3

/**
 * The names a phone number has booked under, shown under the number itself.
 *
 * A number is one WhatsApp account, not one person — the same line books for
 * "Juan Pérez" and "María Pérez" — so these are labels hanging off the contact,
 * never its title. Renders nothing when the number has no bookings yet, which
 * is most of the inbox.
 */
export function NameTags({
  names,
  className,
}: {
  names: string[]
  className?: string
}): React.JSX.Element | null {
  if (names.length === 0) return null

  const visible = names.slice(0, MAX_VISIBLE)
  const hidden = names.length - visible.length

  return (
    <span
      className={cn('text-muted-foreground block truncate text-xs', className)}
      // The full list on hover, for the office line with six names on it.
      title={names.join(' · ')}
    >
      {visible.join(' · ')}
      {hidden > 0 && ` +${hidden}`}
    </span>
  )
}
