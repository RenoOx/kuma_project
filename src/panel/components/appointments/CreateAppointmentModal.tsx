import { Search, UserPlus, X } from 'lucide-react'
import { useState } from 'react'
import type { CreateAppointmentPayload, CustomerListItem, SlotWarning } from '../../api/types.js'
import { useCreateAppointment } from '../../hooks/useAppointments.js'
import { useCustomers } from '../../hooks/useCustomers.js'
import { useMe } from '../../hooks/useMeta.js'
import { useSettings } from '../../hooks/useSettings.js'
import { nicheCopy } from '../../lib/constants.js'
import { formatPhone, todayISO } from '../../lib/utils.js'
import { Button } from '../ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js'
import { Switch } from '../ui/switch.js'
import { Textarea } from '../ui/textarea.js'

/** What the picker settled on: a row from the list, or a number typed by hand. */
type Contact =
  | { kind: 'existing'; customer: CustomerListItem }
  | { kind: 'new'; phone: string; name: string }

/**
 * The owner booking someone into the agenda by hand.
 *
 * The case this exists for is the phone call: somebody rings, asks for Thursday
 * at three, and never writes to the WhatsApp number — so this is also the only
 * place in the panel that can create a contact.
 *
 * Warnings, not errors. The server reports everything the slot breaks (closed
 * day, outside hours, the break, too soon, a clash) and persists nothing; the
 * owner reads them and either fixes the slot or books through them with the
 * same payload plus `force`. Their agenda, their call.
 */
export function CreateAppointmentModal({
  open,
  onClose,
  initialDate,
  initialTime,
}: {
  open: boolean
  onClose: () => void
  /** Prefilled when the modal was opened from an empty slot on the calendar. */
  initialDate?: string
  initialTime?: string
}): React.JSX.Element {
  const { data: settings } = useSettings()
  const { data: me } = useMe()
  const copy = nicheCopy(me?.niche)

  const services = (settings?.settings?.services ?? []).filter((s) => s.active)

  const [contact, setContact] = useState<Contact | null>(null)
  const [service, setService] = useState('')
  const [date, setDate] = useState(initialDate ?? todayISO())
  const [time, setTime] = useState(initialTime ?? '09:00')
  const [notes, setNotes] = useState('')
  const [notify, setNotify] = useState(true)
  const [warnings, setWarnings] = useState<SlotWarning[]>([])

  const { create, saving, error } = useCreateAppointment((result) => {
    if (result.created) {
      onClose()
      return
    }
    setWarnings(result.warnings)
  })

  // Any edit invalidates what the server told us about the previous slot, so
  // "Agendar igual" can never force a payload the owner has since changed.
  const edited = <T,>(set: (v: T) => void) => {
    return (value: T): void => {
      setWarnings([])
      set(value)
    }
  }

  const submit = (force: boolean): void => {
    if (!contact) return
    const payload: CreateAppointmentPayload = {
      ...(contact.kind === 'existing'
        ? { customerId: contact.customer.id }
        : {
            phone: contact.phone.trim(),
            ...(contact.name.trim() ? { customerName: contact.name.trim() } : {}),
          }),
      service,
      date,
      time,
      ...(notes.trim() ? { notes: notes.trim() } : {}),
      notifyCustomer: notify,
      force,
    }
    create(payload)
  }

  const incomplete =
    contact === null ||
    (contact.kind === 'new' && contact.phone.trim().length < 6) ||
    service.length === 0 ||
    date.length === 0 ||
    time.length === 0

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Nueva cita</DialogTitle>
          <DialogDescription>
            Para cuando la reserva no pasó por Emma: una llamada, un {copy.contactSingular} que vino
            en persona.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-4">
          <ContactPicker
            contact={contact}
            onChange={edited(setContact)}
            contactLabel={copy.contactSingular}
          />

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="appt-service">Servicio</Label>
            {services.length === 0 ? (
              <span className="text-muted-foreground text-xs">
                Este negocio no tiene servicios activos. Agregá uno en Servicios.
              </span>
            ) : (
              <Select value={service} onValueChange={edited(setService)}>
                <SelectTrigger id="appt-service">
                  <SelectValue placeholder="Elegí un servicio" />
                </SelectTrigger>
                <SelectContent>
                  {services.map((s) => (
                    <SelectItem key={s.name} value={s.name}>
                      {s.name}
                      {s.durationMinutes ? ` · ${s.durationMinutes} min` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="appt-date">Fecha</Label>
              <Input
                id="appt-date"
                type="date"
                value={date}
                onChange={(e) => edited(setDate)(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="appt-time">Hora</Label>
              <Input
                id="appt-time"
                type="time"
                value={time}
                onChange={(e) => edited(setTime)(e.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="appt-notes">Notas</Label>
            <Textarea
              id="appt-notes"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Opcional. Lo ves vos, no el cliente."
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="appt-notify">Avisar por WhatsApp</Label>
              <span className="text-muted-foreground text-xs">
                Le llega la confirmación con el día y la hora.
              </span>
            </div>
            <Switch id="appt-notify" checked={notify} onCheckedChange={setNotify} />
          </div>

          {warnings.length > 0 && (
            <div className="border-q-needs-info/40 bg-q-needs-info/10 flex flex-col gap-1.5 rounded-md border p-3">
              <p className="text-q-needs-info text-sm font-medium">Revisá este horario</p>
              <ul className="text-muted-foreground flex flex-col gap-1 text-sm">
                {warnings.map((w) => (
                  <li key={w.code}>{w.message}</li>
                ))}
              </ul>
            </div>
          )}

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter className="px-4">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          {warnings.length > 0 ? (
            <Button onClick={() => submit(true)} disabled={incomplete || saving}>
              {saving ? 'Agendando…' : 'Agendar igual'}
            </Button>
          ) : (
            <Button onClick={() => submit(false)} disabled={incomplete || saving}>
              {saving ? 'Agendando…' : 'Agendar'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Who the appointment is for.
 *
 * Search first, because the common case is someone Emma already knows and
 * booking them twice under two rows is how a contact list rots. Typing a new
 * number is the escape hatch, not the default.
 */
function ContactPicker({
  contact,
  onChange,
  contactLabel,
}: {
  contact: Contact | null
  onChange: (contact: Contact | null) => void
  contactLabel: string
}): React.JSX.Element {
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const { data } = useCustomers({ search, page: 1 })

  // Only worth searching once there is something to search for: an empty box
  // would otherwise render the first page of every contact under the field.
  const results = search.trim().length >= 2 ? (data?.data ?? []).slice(0, 5) : []

  if (contact?.kind === 'existing') {
    return (
      <div className="flex flex-col gap-1.5">
        <Label>{contactLabel.charAt(0).toUpperCase() + contactLabel.slice(1)}</Label>
        <div className="border-border bg-emma-elevated flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm">{contact.customer.name ?? 'Sin nombre'}</span>
            <span className="text-muted-foreground text-xs">
              {formatPhone(contact.customer.phone)}
            </span>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onChange(null)}
            aria-label="Elegir otro contacto"
          >
            <X size={15} aria-hidden />
          </Button>
        </div>
      </div>
    )
  }

  if (creating || contact?.kind === 'new') {
    const current =
      contact?.kind === 'new' ? contact : { kind: 'new' as const, phone: '', name: '' }
    return (
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="appt-new-name">Contacto nuevo</Label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            id="appt-new-name"
            value={current.name}
            onChange={(e) => onChange({ ...current, name: e.target.value })}
            placeholder="Nombre"
            maxLength={80}
          />
          <Input
            id="appt-new-phone"
            type="tel"
            inputMode="tel"
            value={current.phone}
            onChange={(e) => onChange({ ...current, phone: e.target.value })}
            placeholder="+51 999 888 777"
            aria-label="Teléfono"
          />
        </div>
        <button
          type="button"
          className="text-muted-foreground hover:text-emma-cream self-start text-xs underline"
          onClick={() => {
            setCreating(false)
            onChange(null)
          }}
        >
          Buscar en mis contactos
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="appt-search">
        {contactLabel.charAt(0).toUpperCase() + contactLabel.slice(1)}
      </Label>
      <div className="relative">
        <Search
          size={15}
          aria-hidden
          className="text-muted-foreground absolute top-1/2 left-3 -translate-y-1/2"
        />
        <Input
          id="appt-search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscá por nombre o teléfono"
          className="pl-9"
        />
      </div>

      {results.length > 0 && (
        <ul className="border-border divide-border divide-y rounded-md border">
          {results.map((customer) => (
            <li key={customer.id}>
              <button
                type="button"
                className="hover:bg-emma-elevated flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
                onClick={() => onChange({ kind: 'existing', customer })}
              >
                <span className="text-sm">{customer.name ?? 'Sin nombre'}</span>
                <span className="text-muted-foreground text-xs">{formatPhone(customer.phone)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {search.trim().length >= 2 && results.length === 0 && (
        <span className="text-muted-foreground text-xs">Ningún contacto con ese nombre.</span>
      )}

      <Button variant="outline" size="sm" className="self-start" onClick={() => setCreating(true)}>
        <UserPlus size={14} aria-hidden />
        Contacto nuevo
      </Button>
    </div>
  )
}
