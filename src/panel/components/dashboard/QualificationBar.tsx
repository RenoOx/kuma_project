import type { QualificationBreakdown } from '../../api/types.js'
import { QUALIFICATION_META, QUALIFICATIONS } from '../../lib/constants.js'
import { PanelLink } from '../../lib/session.js'
import { cn } from '../../lib/utils.js'
import { Skeleton } from '../ui/skeleton.js'

/**
 * How the business's conversations are distributed right now (US-08 AC2).
 *
 * Every tile is a link into the inbox already filtered to that state, which is
 * what makes the number actionable: "14 esperando" is a report, "14 esperando"
 * that opens those fourteen threads is a to-do list.
 */
export function QualificationBar({
  breakdown,
  isLoading,
}: {
  breakdown: QualificationBreakdown | undefined
  isLoading: boolean
}): React.JSX.Element {
  if (isLoading || !breakdown) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
        {QUALIFICATIONS.map((q) => (
          <Skeleton key={q} className="h-16" />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-7">
      {QUALIFICATIONS.map((qualification) => {
        const meta = QUALIFICATION_META[qualification]
        return (
          <PanelLink
            key={qualification}
            to="/"
            params={{ q: qualification }}
            className={cn(
              'bg-card hover:border-primary/50 flex flex-col gap-1 rounded-lg border border-border p-3 transition-colors',
            )}
          >
            <span
              className={cn(
                'w-fit rounded-full px-1.5 py-0.5 text-[11px] font-medium',
                meta.className,
              )}
            >
              {meta.label}
            </span>
            <span className="text-xl font-semibold text-emma-text">
              {breakdown[qualification] ?? 0}
            </span>
          </PanelLink>
        )
      })}
    </div>
  )
}
