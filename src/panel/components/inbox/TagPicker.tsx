import { Check, Settings2, Tag as TagIcon } from 'lucide-react'
import type { PanelTag } from '../../api/types.js'
import { useAssignTags, useTags } from '../../hooks/useTags.js'
import { TAG_COLOR_META } from '../../lib/constants.js'
import { cn } from '../../lib/utils.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js'

/**
 * Assigns the owner's labels to one conversation.
 *
 * Sits where the qualification menu used to, and works the opposite way: that
 * one picked exactly one value from a list nobody chose, this one toggles any
 * number of labels the owner wrote themselves.
 *
 * Every click sends the complete set rather than a delta, so two quick clicks
 * cannot interleave into a state neither of them asked for.
 */
export function TagPicker({
  conversationId,
  assigned,
  onManage,
}: {
  conversationId: string
  assigned: PanelTag[]
  onManage: () => void
}): React.JSX.Element {
  const { data: tags } = useTags()
  const assign = useAssignTags(conversationId)

  const assignedIds = new Set(assigned.map((t) => t.id))

  const toggle = (tag: PanelTag): void => {
    const next = assignedIds.has(tag.id)
      ? assigned.filter((t) => t.id !== tag.id).map((t) => t.id)
      : [...assigned.map((t) => t.id), tag.id]
    assign.mutate(next)
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={assign.isPending}
        aria-label="Etiquetas"
        className="text-muted-foreground hover:text-foreground rounded-md p-1.5 transition-colors disabled:opacity-50"
      >
        <TagIcon size={16} aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuLabel>Etiquetas</DropdownMenuLabel>

        {(tags ?? []).length === 0 ? (
          <p className="text-muted-foreground px-2 py-1.5 text-xs">Todavía no creaste etiquetas.</p>
        ) : (
          (tags ?? []).map((tag) => {
            const on = assignedIds.has(tag.id)
            return (
              <DropdownMenuItem
                key={tag.id}
                // Keeps the menu open: assigning three labels should be three
                // clicks, not three trips back into the menu.
                onSelect={(event) => {
                  event.preventDefault()
                  toggle(tag)
                }}
                className={cn(on && 'font-medium')}
              >
                <span
                  className={cn('size-2 rounded-full', TAG_COLOR_META[tag.color].dotClassName)}
                />
                <span className="flex-1 truncate">{tag.name}</span>
                {on && <Check size={14} aria-hidden />}
              </DropdownMenuItem>
            )
          })
        )}

        <DropdownMenuItem
          onSelect={onManage}
          className="text-muted-foreground border-t border-border"
        >
          <Settings2 size={14} aria-hidden />
          Administrar etiquetas
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
