import { QUALIFICATION_META, type Qualification } from '../../lib/constants.js'
import { cn } from '../../lib/utils.js'
import { Badge } from '../ui/badge.js'

export function QualificationBadge({
  qualification,
  className,
}: {
  qualification: Qualification
  className?: string
}): React.JSX.Element {
  const meta = QUALIFICATION_META[qualification]
  // secondary rather than default: its border is already transparent, so the
  // per-qualification tint from QUALIFICATION_META is the only color that
  // lands. twMerge drops the variant's bg/text in favour of the tint.
  return (
    <Badge variant="secondary" className={cn('rounded-full', meta.className, className)}>
      {meta.label}
    </Badge>
  )
}
