import { useState } from 'react'
import type { AppointmentMode, Niche, PanelSettings } from '../../api/types.js'
import { useSectionSave } from '../../hooks/useSettings.js'
import { NICHES } from '../../lib/constants.js'
import { Input } from '../ui/input.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js'
import { Field, SettingsCard } from './SettingsCard.js'

// The five niches the backend actually accepts (nicheSchema in
// business.settings.ts). Expanding this set is a schema change with live data
// behind it — an existing business is stored as 'barberia' — so it is not done
// from here.
const NICHE_LABELS: Record<Niche, string> = {
  dental: 'Clínica dental',
  barberia: 'Barbería',
  estetica: 'Centro estético / Spa',
  salud: 'Salud y bienestar',
  general: 'Otro',
}

const APPOINTMENT_MODE_LABELS: Record<AppointmentMode, string> = {
  appointments_only: 'Solo con cita previa',
  hybrid: 'Por orden de llegada + citas',
}

// Peru is the only market Emma serves today, but the field is a select rather
// than a fixed value so a business on a different offset is a config change
// instead of a deploy. The server validates against the host's ICU data.
const TIMEZONES = ['America/Lima', 'America/Bogota', 'America/Santiago', 'America/Mexico_City']

export function GeneralSettings({ data }: { data: PanelSettings }): React.JSX.Element {
  const { save, saving, saved, error } = useSectionSave()

  const [name, setName] = useState(data.name)
  const [ownerName, setOwnerName] = useState(data.ownerName ?? '')
  const [address, setAddress] = useState(data.address ?? '')
  const [googleMapsUrl, setGoogleMapsUrl] = useState(data.googleMapsUrl ?? '')
  const [timezone, setTimezone] = useState(data.timezone)
  const [niche, setNiche] = useState<Niche>(data.settings?.niche ?? 'general')
  const [appointmentMode, setAppointmentMode] = useState<AppointmentMode>(
    data.settings?.appointmentMode ?? 'appointments_only',
  )

  const dirty =
    name !== data.name ||
    ownerName !== (data.ownerName ?? '') ||
    address !== (data.address ?? '') ||
    googleMapsUrl !== (data.googleMapsUrl ?? '') ||
    timezone !== data.timezone ||
    niche !== (data.settings?.niche ?? 'general') ||
    appointmentMode !== (data.settings?.appointmentMode ?? 'appointments_only')

  const onSave = (): void => {
    save({
      section: 'general',
      patch: {
        name,
        ownerName,
        address,
        googleMapsUrl,
        timezone,
        niche,
        appointmentMode,
      },
    })
  }

  return (
    <SettingsCard
      title="Datos del negocio"
      description="Cómo se presenta Emma y qué vocabulario usa al escribirle a tus clientes."
      onSave={onSave}
      saving={saving}
      saved={saved}
      error={error}
      dirty={dirty}
    >
      <Field label="Nombre del negocio" htmlFor="cfg-name">
        <Input
          id="cfg-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={120}
        />
      </Field>

      <Field label="Nombre del dueño" htmlFor="cfg-owner">
        <Input
          id="cfg-owner"
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          maxLength={120}
        />
      </Field>

      <Field
        label="Tipo de negocio"
        hint="Define si Emma dice paciente o cliente."
        htmlFor="cfg-niche"
      >
        <Select value={niche} onValueChange={(v) => setNiche(v as Niche)}>
          <SelectTrigger id="cfg-niche">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NICHES.map((value) => (
              <SelectItem key={value} value={value}>
                {NICHE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        label="Modo de atención"
        hint="Si atendés por orden de llegada, Emma lo ofrece como alternativa a la cita."
        htmlFor="cfg-mode"
      >
        <Select
          value={appointmentMode}
          onValueChange={(v) => setAppointmentMode(v as AppointmentMode)}
        >
          <SelectTrigger id="cfg-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(APPOINTMENT_MODE_LABELS) as AppointmentMode[]).map((value) => (
              <SelectItem key={value} value={value}>
                {APPOINTMENT_MODE_LABELS[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Zona horaria" htmlFor="cfg-tz">
        <Select value={timezone} onValueChange={setTimezone}>
          <SelectTrigger id="cfg-tz">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* A business already stored on a zone outside the shortlist keeps
                it: dropping its own value from the options would silently move
                it to Lima on the next save. */}
            {[...new Set([...TIMEZONES, timezone])].map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field
        label="Dirección"
        hint="Emma la usa para responder «¿dónde quedan?»."
        htmlFor="cfg-address"
      >
        <Input
          id="cfg-address"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          maxLength={300}
        />
      </Field>

      <Field label="Link de Google Maps" htmlFor="cfg-maps">
        <Input
          id="cfg-maps"
          type="url"
          inputMode="url"
          placeholder="https://maps.app.goo.gl/…"
          value={googleMapsUrl}
          onChange={(e) => setGoogleMapsUrl(e.target.value)}
          maxLength={500}
        />
      </Field>
    </SettingsCard>
  )
}
