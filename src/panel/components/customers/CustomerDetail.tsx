import { MessageSquare } from 'lucide-react'
import { useCustomerDetail } from '../../hooks/useCustomers.js'
import { APPOINTMENT_META } from '../../lib/constants.js'
import { PanelLink } from '../../lib/session.js'
import { cn, formatLongDateTime, formatPhone, timeAgo } from '../../lib/utils.js'
import { NameTags } from '../NameTags.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Separator } from '../ui/separator.js'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.js'
import { Skeleton } from '../ui/skeleton.js'

export function CustomerDetail({
  customerId,
  onClose,
}: {
  customerId: string | null
  onClose: () => void
}): React.JSX.Element {
  const { data, isLoading, isError } = useCustomerDetail(customerId)

  return (
    <Sheet open={customerId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="pr-8">
            {data ? formatPhone(data.customer.phone) : 'Contacto'}
          </SheetTitle>
          {data && (
            <>
              <NameTags names={data.appointmentNames} />
              {data.customer.lastSeenAt && (
                <p className="text-muted-foreground text-xs">
                  Visto {timeAgo(data.customer.lastSeenAt)}
                </p>
              )}
            </>
          )}
        </SheetHeader>

        <div className="space-y-5 px-4 pb-4">
          {isLoading && <Skeleton className="h-24 w-full" />}
          {isError && <p className="text-destructive text-sm">No pudimos cargar este contacto.</p>}

          {data && (
            <>
              {data.customer.whatsappUnreachableAt && (
                <p className="bg-destructive/10 text-destructive rounded-md p-2 text-xs">
                  WhatsApp marcó este número como inactivo. Emma no le envía mensajes.
                </p>
              )}

              <Button variant="outline" size="sm" asChild className="w-full">
                {/* Searching by phone rather than linking a conversation id:
                    the inbox filters by number, which lands on this customer's
                    threads whichever one is most recent. */}
                <PanelLink to="/" params={{ search: data.customer.phone }}>
                  <MessageSquare size={14} aria-hidden />
                  Ver en el inbox
                </PanelLink>
              </Button>

              <Separator />

              <section className="space-y-2">
                <h3 className="text-emma-text text-xs font-medium">Citas</h3>
                {data.appointments.length === 0 && (
                  <p className="text-muted-foreground text-sm">Sin citas registradas.</p>
                )}
                {data.appointments.map((appointment) => {
                  const meta = APPOINTMENT_META[appointment.status]
                  return (
                    <div
                      key={appointment.id}
                      className="bg-card flex items-start justify-between gap-2 rounded-md border border-border p-2.5"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm">{appointment.service}</p>
                        <p className="text-muted-foreground text-xs">
                          {formatLongDateTime(appointment.scheduledAt)}
                        </p>
                      </div>
                      <Badge
                        variant="secondary"
                        className={cn('shrink-0 rounded-full', meta.className)}
                      >
                        {meta.label}
                      </Badge>
                    </div>
                  )
                })}
              </section>

              <section className="space-y-2">
                <h3 className="text-emma-text text-xs font-medium">Conversaciones</h3>
                {data.conversations.length === 0 && (
                  <p className="text-muted-foreground text-sm">Sin conversaciones.</p>
                )}
                {data.conversations.map((conversation) => (
                  <div
                    key={conversation.id}
                    className="bg-card flex items-center justify-between gap-2 rounded-md border border-border p-2.5"
                  >
                    <p className="text-muted-foreground text-xs">
                      {conversation.lastMessageAt
                        ? `Último mensaje ${timeAgo(conversation.lastMessageAt)}`
                        : 'Sin mensajes'}
                    </p>
                    {/* The label used to be the qualification. Status is what is
                        left that describes the thread without the owner having
                        tagged it — their own tags live in the inbox. */}
                    <Badge variant="secondary" className="shrink-0 rounded-full">
                      {conversation.status === 'escalated' ? 'Escalada' : 'Abierta'}
                    </Badge>
                  </div>
                ))}
              </section>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
