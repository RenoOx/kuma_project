import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ConversationListItem } from '../api/types.js'
import { CustomerDetail } from '../components/customers/CustomerDetail.js'
import { CustomerList } from '../components/customers/CustomerList.js'
import { ChatView } from '../components/inbox/ChatView.js'
import { ConversationList } from '../components/inbox/ConversationList.js'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs.js'
import { useMe } from '../hooks/useMeta.js'
import { nicheCopy } from '../lib/constants.js'
import { cn } from '../lib/utils.js'

/**
 * Inbox: conversations and contacts, as two tabs.
 *
 * Contacts moved in here from its own sidebar section: the owner reaching for a
 * contact is almost always on their way to a conversation, and the round trip
 * through the nav was in the way. `/contactos` still resolves — the appointment
 * sheet links into it with ?customer=… — it just is not its own destination in
 * the rail any more.
 *
 * The tab lives in the URL so those links keep landing where they mean to.
 */
export function InboxPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams()
  const { data: me } = useMe()
  const copy = nicheCopy(me?.niche)

  const tab = params.get('tab') === 'contactos' ? 'contactos' : 'conversaciones'

  const setTab = (next: string): void => {
    setParams(
      (prev) => {
        const updated = new URLSearchParams(prev)
        if (next === 'conversaciones') updated.delete('tab')
        else updated.set('tab', next)
        return updated
      },
      { replace: true },
    )
  }

  const selectedCustomer = params.get('customer')

  const setSelectedCustomer = (customerId: string | null): void => {
    setParams((prev) => {
      const updated = new URLSearchParams(prev)
      if (customerId) updated.set('customer', customerId)
      else updated.delete('customer')
      return updated
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1">
        <TabsList className="shrink-0">
          <TabsTrigger value="conversaciones">Conversaciones</TabsTrigger>
          <TabsTrigger value="contactos">{copy.contactsLabel}</TabsTrigger>
        </TabsList>

        {/* Both panes stay mounted: TabsContent hides the inactive one rather
            than unmounting it, so switching to Contacts and back does not throw
            away the open conversation or the scroll position in the chat. */}
        <TabsContent value="conversaciones" className="min-h-0">
          <ConversationsPane ownerName={me?.ownerName ?? null} />
        </TabsContent>

        <TabsContent value="contactos" className="min-h-0">
          <CustomerList
            contactsLabel={copy.contactsLabel}
            onSelect={setSelectedCustomer}
            showHeading={false}
          />
        </TabsContent>
      </Tabs>

      <CustomerDetail customerId={selectedCustomer} onClose={() => setSelectedCustomer(null)} />
    </div>
  )
}

/**
 * List on the left, chat on the right.
 *
 * On phones the two share one space — the list fills it until a conversation is
 * picked, then the chat replaces it and a back button returns. One layout with a
 * breakpoint rather than two component trees, so there is no chance of the two
 * drifting apart.
 *
 * The selected row is held whole, not by id. Looking it up by id would mean
 * searching a list this component does not own: the filters live inside
 * ConversationList, so filtering to one label and opening a thread would leave
 * the lookup empty and the chat blank. The row's live fields come from
 * useMessages inside ChatView, which refreshes on its own.
 */
function ConversationsPane({ ownerName }: { ownerName: string | null }): React.JSX.Element {
  const [selected, setSelected] = useState<ConversationListItem | null>(null)

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
            ownerName={ownerName}
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
