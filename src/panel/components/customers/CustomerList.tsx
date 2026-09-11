import { Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CustomerListItem } from '../../api/types.js'
import { useCustomers } from '../../hooks/useCustomers.js'
import { formatPhone, timeAgo } from '../../lib/utils.js'
import { NameTags } from '../NameTags.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table.js'

const PAGE_SIZE = 20

export function CustomerList({
  contactsLabel,
  onSelect,
}: {
  contactsLabel: string
  onSelect: (customerId: string) => void
}): React.JSX.Element {
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(1)
    }, 300)
    return () => clearTimeout(timer)
  }, [searchInput])

  const { data, isLoading, isError } = useCustomers({ ...(search ? { search } : {}), page })
  const items = data?.data ?? []
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE))

  return (
    <div className="bg-emma-bg-secondary border-border flex h-full min-h-0 flex-col overflow-hidden rounded-xl border">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h1 className="text-base font-semibold text-emma-text">{contactsLabel}</h1>
        <div className="relative w-full sm:w-64">
          <label htmlFor="customers-search" className="sr-only">
            Buscar por nombre o teléfono
          </label>
          <Search
            size={15}
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 z-10 -translate-y-1/2"
          />
          <Input
            id="customers-search"
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Buscar nombre o teléfono"
            className="bg-emma-bg pl-8"
          />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading && <Notice>Cargando…</Notice>}
        {isError && <Notice>No pudimos cargar la lista.</Notice>}
        {!isLoading && !isError && items.length === 0 && (
          <Notice>
            {search
              ? 'Nadie coincide con esa búsqueda.'
              : `Todavía no hay ${contactsLabel.toLowerCase()}.`}
          </Notice>
        )}

        {/* Gutters on the outer cells rather than padding on a wrapper, so the
            row's hover state still runs the full width of the list. */}
        {items.length > 0 && (
          <Table className="[&_tr>*:first-child]:pl-4 [&_tr>*:last-child]:pr-4">
            <TableHeader>
              <TableRow>
                <TableHead>Contacto</TableHead>
                <TableHead>Última interacción</TableHead>
                <TableHead className="hidden md:table-cell text-right">Conversaciones</TableHead>
                <TableHead className="hidden md:table-cell text-right">Citas</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((customer) => (
                <CustomerRow key={customer.id} customer={customer} onSelect={onSelect} />
              ))}
            </TableBody>
          </Table>
        )}
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

function CustomerRow({
  customer,
  onSelect,
}: {
  customer: CustomerListItem
  onSelect: (customerId: string) => void
}): React.JSX.Element {
  return (
    <TableRow
      onClick={() => onSelect(customer.id)}
      className="cursor-pointer"
      // The row is the target, so it needs the keyboard affordance a button
      // would have given for free.
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(customer.id)
        }
      }}
    >
      <TableCell>
        <div className="flex flex-col gap-1">
          <span className="font-medium">{formatPhone(customer.phone)}</span>
          <NameTags names={customer.appointmentNames} />
          {customer.unreachable && (
            <Badge variant="secondary" className="bg-q-lost/15 text-q-lost w-fit rounded-full">
              Número inactivo
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground">{timeAgo(customer.lastSeenAt) || '—'}</TableCell>
      <TableCell className="hidden md:table-cell text-right">
        {customer.conversationCount}
      </TableCell>
      <TableCell className="hidden md:table-cell text-right">{customer.appointmentCount}</TableCell>
    </TableRow>
  )
}

function Notice({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="text-muted-foreground px-4 py-8 text-center text-sm">{children}</p>
}
