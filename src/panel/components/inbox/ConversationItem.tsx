import type { ConversationListItem } from '../../api/types.js'
import { cn, formatPhone, initials, timeAgo, truncate } from '../../lib/utils.js'
import { NameTags } from '../NameTags.js'
import { Avatar, AvatarFallback } from '../ui/avatar.js'
import { TagBadge } from './TagBadge.js'

export function ConversationItem({
  conversation,
  selected,
  onSelect,
}: {
  conversation: ConversationListItem
  selected: boolean
  onSelect: (conversation: ConversationListItem) => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => onSelect(conversation)}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-start gap-3 border-b border-border px-3 py-3 text-left transition-colors',
        selected ? 'bg-emma-accent/10' : 'hover:bg-accent/40',
      )}
    >
      <Avatar className="mt-0.5 size-9">
        {/* Seeded from the number, not from a name: the number is what this row
            is identified by, and a name here would contradict the line below. */}
        <AvatarFallback>{initials(null, conversation.phone)}</AvatarFallback>
      </Avatar>

      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm font-medium text-emma-text">
            {formatPhone(conversation.phone)}
          </span>
          <span className="text-muted-foreground shrink-0 text-[11px]">
            {timeAgo(conversation.lastMessageAt)}
          </span>
        </span>

        <NameTags names={conversation.appointmentNames} className="mt-0.5" />

        <span className="text-muted-foreground mt-0.5 block truncate text-xs">
          {conversation.lastMessagePreview
            ? truncate(conversation.lastMessagePreview, 60)
            : 'Sin mensajes'}
        </span>

        {conversation.tags.length > 0 && (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {conversation.tags.map((tag) => (
              <TagBadge key={tag.id} tag={tag} />
            ))}
          </span>
        )}
      </span>
    </button>
  )
}
