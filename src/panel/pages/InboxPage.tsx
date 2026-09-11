import { useState } from 'react'
import type { ConversationListItem } from '../api/types.js'
import { ChatView } from '../components/inbox/ChatView.js'
import { ConversationList } from '../components/inbox/ConversationList.js'
import { useMe } from '../hooks/useMeta.js'
import { cn } from '../lib/utils.js'

/**
 * Inbox: list on the left, chat on the right.
 *
 * On phones the two share one space — the list fills it until a conversation is
 * picked, then the chat replaces it and a back button returns. One layout with a
 * breakpoint rather than two component trees, so there is no chance of the two
 * drifting apart.
 *
 * The selected row is held whole, not by id. Looking it up by id would mean
 * searching a list this component does not own: the filters live inside
 * ConversationList, so filtering to "Perdidos" and opening a thread would leave
 * the lookup empty and the chat blank. The row's live fields (badge, transcript)
 * come from useMessages inside ChatView, which refreshes on its own.
 */
export function InboxPage(): React.JSX.Element {
  const [selected, setSelected] = useState<ConversationListItem | null>(null)
  const { data: me } = useMe()

  return (
    <div className="flex h-full min-h-0 gap-3">
      <div
        className={cn(
          'h-full min-h-0 w-full md:w-80 lg:w-96',
          selected ? 'hidden md:block' : 'block',
        )}
      >
        <ConversationList selectedId={selected?.id ?? null} onSelect={setSelected} />
      </div>

      <div className={cn('h-full min-h-0 flex-1', selected ? 'block' : 'hidden md:block')}>
        {selected ? (
          <ChatView
            // Remounts on change, so scroll position and the pending-message
            // list never leak from one conversation into the next.
            key={selected.id}
            conversation={selected}
            ownerName={me?.ownerName ?? null}
            onBack={() => setSelected(null)}
          />
        ) : (
          <div className="border-border flex h-full items-center justify-center rounded-xl border p-6">
            <p className="text-sm text-muted-foreground">
              Elegí una conversación para ver el chat.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
