import { CalendarClock, Phone, Stethoscope, User } from 'lucide-react'
import type { PanelAppointment } from '../../api/types.js'
import { APPOINTMENT_META } from '../../lib/constants.js'
import { PanelLink } from '../../lib/session.js'
import { cn, formatLongDateTime } from '../../lib/utils.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '../ui/sheet.js'
import { AppointmentActions } from './AppointmentActions.js'

export function AppointmentDetail({
  appointment,
  contactsLabel,
  onClose,
}: {
  appointment: PanelAppointment | null
  contactsLabel: string
  onClose: () => void
}): React.JSX.Element {
  const meta = appointment ? APPOINTMENT_META[appointment.status] : null

  return (
    <Sheet open={appointment !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        {appointment && meta && (
          <>
            <SheetHeader>
              <SheetTitle className="pr-8">
                {appointment.customerName ?? appointment.customerPhone}
              </SheetTitle>
              <Badge variant="secondary" className={cn('w-fit rounded-full', meta.className)}>
                {meta.label}
              </Badge>
            </SheetHeader>

            <div className="space-y-4 px-4">
              <Field icon={Stethoscope} label="Servicio" value={appointment.service} />
              <Field
                icon={CalendarClock}
                label="Fecha y hora"
                value={`${formatLongDateTime(appointment.scheduledAt)} · ${appointment.durationMinutes} min`}
              />
              <Field icon={Phone} label="Teléfono" value={appointment.customerPhone} />

              {appointment.notes && (
                <div>
                  <p className="text-muted-foreground text-xs">Notas</p>
                  <p className="mt-1 text-sm whitespace-pre-wrap">{appointment.notes}</p>
                </div>
              )}

              <Button variant="outline" size="sm" asChild className="w-full">
                {/* Opens the contacts view with this customer's sheet already
                    open, so the owner can see their history without searching. */}
                <PanelLink to="/contactos" params={{ customer: appointment.customerId }}>
                  <User size={14} aria-hidden />
                  Ver perfil en {contactsLabel}
                </PanelLink>
              </Button>
            </div>

            <div className="mt-auto border-t border-border p-4">
              <AppointmentActions appointment={appointment} onDone={onClose} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Field({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof User
  label: string
  value: string
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5">
      <Icon size={15} aria-hidden className="text-muted-foreground mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="text-sm break-words">{value}</p>
      </div>
    </div>
  )
}
