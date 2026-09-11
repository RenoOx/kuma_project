import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ConversationListItem } from '../../api/types.js'
import { useConversations } from '../../hooks/useConversations.js'
import { useDragScroll } from '../../hooks/useDragScroll.js'
import { QUALIFICATION_META, QUALIFICATIONS, type Qualification } from '../../lib/constants.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs.js'
import { ConversationItem } from './ConversationItem.js'

const PAGE_SIZE = 20

type Tab = Qualification | 'all'

/** Anything the URL does not recognise is "Todos" rather than an empty inbox. */
function toTab(value: string | null): Tab {
  return value && (QUALIFICATIONS as readonly string[]).includes(value)
    ? (value as Qualification)
    : 'all'
}

export function ConversationList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null
  onSelect: (conversation: ConversationListItem) => void
}): React.JSX.Element {
  // The filter and the search term live in the URL, not in state: the dashboard
  // links straight into a filtered inbox and a customer's row links into a
  // pre-searched one. Holding them locally would make those links land on an
  // unfiltered list.
  const [params, setParams] = useSearchParams()
  const tab = toTab(params.get('q'))
  const search = params.get('search') ?? ''

  const [searchInput, setSearchInput] = useState(() => params.get('search') ?? '')
  const [page, setPage] = useState(1)
  const filters = useDragScroll<HTMLDivElement>()

  // Debounced so typing "juan" is one request, not four. 300ms is below the
  // threshold where a search box starts feeling unresponsive. `replace` keeps
  // every keystroke out of the browser's back history.
  //
  // The page resets alongside the term, here and in selectTab below, rather
  // than in an effect watching both: page 3 of "Todos" is not page 3 of
  // "Perdidos", and landing on an out-of-range page reads as "no results".
  useEffect(() => {
    const timer = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          const term = searchInput.trim()
          if (term) next.set('search', term)
          else next.delete('search')
          return next
        },
        { replace: true },
      )
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput, setParams])

  const selectTab = (next: string): void => {
    setParams((prev) => {
      const query = new URLSearchParams(prev)
      if (next === 'all') query.delete('q')
      else query.set('q', next)
      return query
    })
    setPage(1)
  }

  const { data, isLoading, isError } = useConversations({
    ...(tab === 'all' ? {} : { qualification: tab }),
    ...(search ? { search } : {}),
    page,
  })

  const items = data?.data ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    // A block, not a column of the page: the chat beside it is its own block
    // with its own border, so the rule that used to divide them is gone.
    // overflow-hidden is what makes the radius real — without it the first and
    // last rows square off the corners they sit in.
    <div className="bg-emma-bg-secondary border-border flex h-full min-h-0 flex-col overflow-hidden rounded-xl border">
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <div className="relative">
          <label htmlFor="inbox-search" className="sr-only">
            Buscar por nombre o teléfono
          </label>
          <Search
            size={15}
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2"
          />
          <Input
            id="inbox-search"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar nombre o teléfono"
            // Darker than the block it sits in, unlike the reply field, which
            // sits on the chat and is lighter than it. Same rule both times:
            // the field steps away from whatever is behind it.
            className="bg-emma-bg pl-8"
          />
        </div>

        {/* min-w-0 on both levels is what makes the overflow real: a flex item
            will not shrink below its content unless told to, so without it the
            row grew wider than the panel and there was nothing to scroll.
            useDragScroll supplies the gesture — drag and wheel — because an
            overflowing strip with no way to move it reads as broken. */}
        <Tabs value={tab} onValueChange={selectTab} className="min-w-0">
          <TabsList
            ref={filters.ref}
            {...filters.dragProps}
            className="no-scrollbar w-full min-w-0 flex-nowrap justify-start overflow-x-auto rounded-full"
          >
            <TabsTrigger value="all" className="flex-none rounded-full">
              Todos
            </TabsTrigger>
            {QUALIFICATIONS.map((q) => (
              <TabsTrigger key={q} value={q} className="flex-none rounded-full">
                {QUALIFICATION_META[q].label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <Notice>Cargando conversaciones…</Notice>}
        {isError && <Notice>No pudimos cargar las conversaciones.</Notice>}
        {!isLoading && !isError && items.length === 0 && (
          // Two different situations that must not read the same: an empty
          // inbox is a business waiting for its first message, an empty search
          // is a query that matched nothing.
          <Notice>
            {search || tab !== 'all'
              ? 'No hay conversaciones que coincidan con este filtro.'
              : 'Todavía no hay conversaciones.'}
          </Notice>
        )}

        {items.map((conversation) => (
          <ConversationItem
            key={conversation.id}
            conversation={conversation}
            selected={conversation.id === selectedId}
            onSelect={onSelect}
          />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="text-muted-foreground flex shrink-0 items-center justify-between border-t border-border px-3 py-2 text-xs">
          <Button
            variant="ghost"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Anterior
          </Button>
          <span>
            {page} / {totalPages}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            Siguiente
          </Button>
        </div>
      )}
    </div>
  )
}

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-muted-foreground px-4 py-8 text-center text-sm">{children}</p>
}
