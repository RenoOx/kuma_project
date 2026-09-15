import { useState } from 'react'
import type { BookingMode, BusinessSettingsView } from '../../api/types.js'
import { useSectionSave } from '../../hooks/useSettings.js'
import { Input } from '../ui/input.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js'
import { Switch } from '../ui/switch.js'
import { Field, SettingsCard } from './SettingsCard.js'

const BOOKING_MODE_LABELS: Record<BookingMode, string> = {
  direct: 'Emma agenda directo',
  requires_approval: 'Emma pide tu aprobación',
}

export function BookingSettings({
  settings,
}: {
  settings: BusinessSettingsView
}): React.JSX.Element {
  const { save, saving, saved, error } = useSectionSave()

  const [bookingMode, setBookingMode] = useState<BookingMode>(settings.bookingMode)
  const [slotDuration, setSlotDuration] = useState(String(settings.slotDurationMinutes))
  const [minNotice, setMinNotice] = useState(
    settings.minBookingNoticeMinutes === undefined ? '' : String(settings.minBookingNoticeMinutes),
  )
  const [forwardImages, setForwardImages] = useState(settings.forwardImages)
  const [reminders, setReminders] = useState(settings.postBooking.reminders)

  const originalNotice =
    settings.minBookingNoticeMinutes === undefined ? '' : String(settings.minBookingNoticeMinutes)

  const dirty =
    bookingMode !== settings.bookingMode ||
    slotDuration !== String(settings.slotDurationMinutes) ||
    minNotice !== originalNotice ||
    forwardImages !== settings.forwardImages ||
    reminders !== settings.postBooking.reminders

  const onSave = (): void => {
    save({
      section: 'booking',
      patch: {
        bookingMode,
        slotDurationMinutes: Number(slotDuration),
        // Empty means "leave it unset", which the server reads as the 30-minute
        // default. Sending 0 instead would be a real value meaning "no notice
        // required" — a different thing, and not what a cleared field says.
        ...(minNotice === '' ? {} : { minBookingNoticeMinutes: Number(minNotice) }),
        forwardImages,
        postBooking: { ...settings.postBooking, reminders },
      },
    })
  }

  // Forwarding is forced on while a deposit is required: a business charging an
  // advance has to see the capture. Mirrors shouldForwardImages on the server,
  // which ORs the two — the toggle is shown locked rather than lying about it.
  const forwardingForced = settings.requiresDeposit

  return (
    <SettingsCard
      title="Reservas y avisos"
      description="Cómo cierra Emma una cita y qué le manda al cliente después."
      onSave={onSave}
      saving={saving}
      saved={saved}
      error={error}
      dirty={dirty}
    >
      <Field label="Modo de reserva" htmlFor="cfg-booking-mode">
        <Select value={bookingMode} onValueChange={(v) => setBookingMode(v as BookingMode)}>
          <SelectTrigger id="cfg-booking-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(BOOKING_MODE_LABELS) as BookingMode[]).map((value) => (
              <SelectItem key={value} value={value}>
                {BOOKING_MODE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        label="Duración del turno"
        hint="En minutos. Se usa cuando el servicio no tiene una duración propia."
        htmlFor="cfg-slot"
      >
        <Input
          id="cfg-slot"
          type="number"
          inputMode="numeric"
          min={5}
          max={480}
          className="w-32"
          value={slotDuration}
          onChange={(e) => setSlotDuration(e.target.value)}
        />
      </Field>

      <Field
        label="Anticipación mínima"
        hint="En minutos. Emma no ofrece horarios más cerca que esto. Vacío = 30."
        htmlFor="cfg-notice"
      >
        <Input
          id="cfg-notice"
          type="number"
          inputMode="numeric"
          min={0}
          max={1440}
          className="w-32"
          placeholder="30"
          value={minNotice}
          onChange={(e) => setMinNotice(e.target.value)}
        />
      </Field>

      <Field
        label="Reenviar imágenes"
        hint={
          forwardingForced
            ? 'Obligatorio mientras pidas adelanto: necesitás ver el comprobante.'
            : 'Emma te reenvía a tu WhatsApp las fotos que manden los clientes.'
        }
        htmlFor="cfg-forward"
      >
        <Switch
          id="cfg-forward"
          checked={forwardImages || forwardingForced}
          disabled={forwardingForced}
          onCheckedChange={setForwardImages}
        />
      </Field>

      <Field
        label="Recordatorios automáticos"
        hint="Emma le recuerda la cita al cliente 24 h y 2 h antes."
        htmlFor="cfg-reminders"
      >
        <Switch id="cfg-reminders" checked={reminders} onCheckedChange={setReminders} />
      </Field>
    </SettingsCard>
  )
}
