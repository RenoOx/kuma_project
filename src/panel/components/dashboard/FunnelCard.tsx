import type { FunnelReport } from '../../api/types.js'
import { PanelLink } from '../../lib/session.js'
import { cn, formatDateTime, formatPhone } from '../../lib/utils.js'
import { Card, CardContent } from '../ui/card.js'
import { Skeleton } from '../ui/skeleton.js'

// El embudo de ventas de un negocio que vende (Tecmin): de los leads del
// período, cuántos llegaron a cada paso. Debajo, lo que hay que atender HOY
// (fotos sin validar, chats escalados) y las señales de que algo falló.

export function FunnelCard({
  funnel,
  isLoading,
}: {
  funnel: FunnelReport | null | undefined
  isLoading: boolean
}): React.JSX.Element | null {
  if (isLoading) {
    return (
      <Card>
        <CardContent className="space-y-3">
          <Skeleton className="h-3 w-32" />
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-6 w-full" />
          ))}
        </CardContent>
      </Card>
    )
  }
  if (!funnel) return null

  const { steps, pendingValidation, escalated, signals } = funnel

  return (
    <section className="space-y-3">
      <h2 className="text-emma-text text-xs font-medium">Embudo de ventas</h2>

      <Card>
        <CardContent className="space-y-2.5">
          {steps.map((step) => (
            <div key={step.label} className="space-y-1">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-emma-text">{step.label}</span>
                <span className="text-emma-text font-semibold tabular-nums">
                  {step.count}
                  <span className="text-muted-foreground ml-1.5 font-normal">{step.pct}%</span>
                </span>
              </div>
              <div className="bg-emma-elevated h-2 overflow-hidden rounded-full">
                <div
                  className="bg-emma-accent h-full rounded-full"
                  style={{ width: `${step.pct}%` }}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        <AttentionList
          title="Por validar"
          empty="Nadie esperando validación."
          items={pendingValidation.map((p) => ({
            key: p.conversationId,
            name: p.customerName,
            phone: p.phone,
            detail: p.hoursWaiting === null ? null : `${p.hoursWaiting} h esperando`,
          }))}
        />
        <AttentionList
          title="Escalados"
          empty="Ningún chat escalado en el período."
          items={escalated.map((e) => ({
            key: e.conversationId,
            name: e.customerName,
            phone: e.phone,
            detail: [e.reason, e.escalatedAt ? formatDateTime(e.escalatedAt) : null]
              .filter(Boolean)
              .join(' · '),
          }))}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Signal label="Escaladas" value={signals.escalations} />
        <Signal label="Escaladas frenadas" value={signals.escalationsBlocked} />
        <Signal label="Emma no pudo responder" value={signals.unanswered} warn />
        <Signal label="Audios recibidos" value={signals.audios} />
      </div>
    </section>
  )
}

function AttentionList({
  title,
  empty,
  items,
}: {
  title: string
  empty: string
  items: Array<{ key: string; name: string | null; phone: string; detail: string | null }>
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className="space-y-2">
        <p className="text-emma-text text-xs font-medium">
          {title}
          <span className="text-muted-foreground ml-1.5 font-normal">{items.length}</span>
        </p>
        {items.length === 0 ? (
          <p className="text-muted-foreground text-xs">{empty}</p>
        ) : (
          <ul className="divide-emma-border divide-y">
            {items.map((item) => (
              <li key={item.key} className="py-1.5">
                {/* Abre el Inbox filtrado por el teléfono de ese cliente. */}
                <PanelLink
                  to="/"
                  params={{ search: item.phone.replace(/\D/g, '') }}
                  className="hover:bg-emma-elevated -mx-1.5 block rounded px-1.5 py-0.5"
                >
                  <span className="text-emma-text block text-xs">
                    {item.name ?? formatPhone(item.phone)}
                  </span>
                  {item.detail && (
                    <span className="text-muted-foreground block text-xs">{item.detail}</span>
                  )}
                </PanelLink>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function Signal({
  label,
  value,
  warn = false,
}: {
  label: string
  value: number
  warn?: boolean
}): React.JSX.Element {
  return (
    <Card>
      <CardContent className="space-y-1">
        <p className="text-emma-text text-xs">{label}</p>
        <p
          className={cn(
            'text-2xl font-semibold',
            warn && value > 0 ? 'text-destructive' : 'text-emma-text',
          )}
        >
          {value}
        </p>
      </CardContent>
    </Card>
  )
}
