import { useState } from 'react'
import type { PanelSettings } from '../../api/types.js'
import { useSectionSave } from '../../hooks/useSettings.js'
import { Input } from '../ui/input.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js'
import { Field, SettingsCard } from './SettingsCard.js'

// El tipo de negocio (nicho) ya no se edita acá: lo define Vamvu al crear el
// negocio. Sigue vivo en settings y decide la voz, los ejemplos del prompt, los
// límites clínicos de dental y salud y si el panel dice paciente o cliente. Este
// formulario no lo manda, y el merge deja intacto lo guardado (patchable).

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

  const dirty =
    name !== data.name ||
    ownerName !== (data.ownerName ?? '') ||
    address !== (data.address ?? '') ||
    googleMapsUrl !== (data.googleMapsUrl ?? '') ||
    timezone !== data.timezone

  const onSave = (): void => {
    save({
      section: 'general',
      patch: {
        name,
        ownerName,
        address,
        googleMapsUrl,
        timezone,
      },
    })
  }

  return (
    <SettingsCard
      title="Datos del negocio"
      description="Cómo se llama tu negocio, dónde está y en qué zona horaria atiende."
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
