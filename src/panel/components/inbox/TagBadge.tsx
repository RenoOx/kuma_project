import type { PanelTag } from '../../api/types.js'
import { TAG_COLOR_META } from '../../lib/constants.js'
import { cn } from '../../lib/utils.js'
import { Badge } from '../ui/badge.js'

/**
 * One of the owner's labels.
 *
 * `variant="secondary"` for the same reason the qualification badge used it:
 * its border is transparent, so the tint shows through, and twMerge lets the
 * colour classes below override the variant's own background and text.
 */
export function TagBadge({
  tag,
  className,
}: {
  tag: PanelTag
  className?: string
}): React.JSX.Element {
  const meta = TAG_COLOR_META[tag.color]
  return (
    <Badge variant="secondary" className={cn('rounded-full', meta.className, className)}>
      {tag.name}
    </Badge>
  )
}
