import { CalendarCheck, MessageCircle } from 'lucide-react'
import { useIntegrations } from '../../hooks/useSettings.js'
import { formatPhone, timeAgo } from '../../lib/utils.js'
import { Badge } from '../ui/badge.js'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js'
import { Skeleton } from '../ui/skeleton.js'

/**
 * Status of both integrations, with nothing to click.
 *
 * Pairing a WhatsApp session or dropping one is not reachable from here on
 * purpose. The credential to this panel is a token in a URL that gets forwarded
 * and screenshotted; behind it, "Desconectar" would take the business's own
 * number off WhatsApp, and repeated pairing attempts are what get a number
 * rate-limited. Both stay with Vamvu Labs, in the admin surface.
 */
export function IntegrationsPanel(): React.JSX.Element {
  const { data, isLoading } = useIntegrations()

  if (isLoading || !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Conexiones</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Conexiones</CardTitle>
        <CardDescription>
          Para conectar o desconectar una cuenta, escribinos a Vamvu Labs.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col divide-y divide-border">
        <Row
          icon={<MessageCircle size={18} aria-hidden />}
          title="WhatsApp"
          detail={formatPhone(data.whatsapp.number)}
          connected={data.whatsapp.connected}
          note={
            data.whatsapp.connected
              ? null
              : data.whatsapp.lastEventAt
                ? `Sin conexión desde ${timeAgo(data.whatsapp.lastEventAt)}`
                : 'Sin conexión'
          }
        />
        <Row
          icon={<CalendarCheck size={18} aria-hidden />}
          title="Google Calendar"
          detail={
            data.googleCalendar.connected
              ? 'Las citas se copian a tu calendario'
              : 'Las citas solo viven en el panel'
          }
          connected={data.googleCalendar.connected}
          note={null}
        />
      </CardContent>
    </Card>
  )
}

function Row({
  icon,
  title,
  detail,
  connected,
  note,
}: {
  icon: React.ReactNode
  title: string
  detail: string
  connected: boolean
  note: string | null
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 py-3">
      <span className="text-muted-foreground">{icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-muted-foreground truncate text-xs">{note ?? detail}</p>
      </div>
      <Badge
        variant="secondary"
        className={connected ? 'bg-q-qualified/15 text-q-qualified' : 'bg-q-lost/15 text-q-lost'}
      >
        {connected ? 'Conectado' : 'Desconectado'}
      </Badge>
    </div>
  )
}
