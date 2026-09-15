import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { DayHours, SpecialDay } from '../../api/types.js'
import { useSectionSave } from '../../hooks/useSettings.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Switch } from '../ui/switch.js'
import { SettingsCard } from './SettingsCard.js'

const OPEN_DEFAULT: DayHours = { open: '09:00', close: '13:00' }

function todayISO(): string {
  // The date input wants a local calendar date, so this reads the local day
  // rather than slicing an ISO string in UTC — which is the previous day for
  // Lima all evening.
  const now = new Date()
  const month = `${now.getMonth() + 1}`.padStart(2, '0')
  const day = `${now.getDate()}`.padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/**
 * Date-specific overrides of the weekly schedule: holidays, one-off hours.
 *
 * The whole list is sent on save rather than one entry at a time. `specialDays`
 * is an array inside a jsonb document with no stable ids, so "delete the third
 * one" has nothing to address — the UI owns the list and hands it back entire.
 */
export function SpecialDays({ days }: { days: SpecialDay[] }): React.JSX.Element {
  const { save, saving, saved, error } = useSectionSave()
  const [draft, setDraft] = useState<SpecialDay[]>(days)

  const dirty = JSON.stringify(draft) !== JSON.stringify(days)

  const update = (index: number, next: SpecialDay): void => {
    setDraft((prev) => prev.map((d, i) => (i === index ? next : d)))
  }

  const remove = (index: number): void => {
    setDraft((prev) => prev.filter((_, i) => i !== index))
  }

  const add = (): void => {
    setDraft((prev) => [...prev, { date: todayISO(), hours: null, label: '' }])
  }

  return (
    <SettingsCard
      title="Días especiales"
      description="Feriados y excepciones. Lo que pongas acá manda sobre el horario semanal para esa fecha."
      onSave={() =>
        save({
          section: 'specialDays',
          // An empty label is not a label. Sending '' would store a blank
          // string the schema accepts and nothing ever reads.
          specialDays: draft.map((d) => (d.label?.trim() ? d : { date: d.date, hours: d.hours })),
        })
      }
      saving={saving}
      saved={saved}
      error={error}
      dirty={dirty}
    >
      {draft.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No hay días especiales cargados. Emma usa el horario semanal todos los días.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {draft.map((day, index) => (
            <SpecialDayRow
              // The date is what identifies a row to the person reading it, but
              // two rows can briefly share one while being edited, so the index
              // rides along to keep the key unique.
              key={`${day.date}-${index}`}
              day={day}
              onChange={(next) => update(index, next)}
              onRemove={() => remove(index)}
            />
          ))}
        </div>
      )}

      <div>
        <Button variant="outline" size="sm" onClick={add}>
          <Plus size={14} aria-hidden />
          Agregar día
        </Button>
      </div>
    </SettingsCard>
  )
}

function SpecialDayRow({
  day,
  onChange,
  onRemove,
}: {
  day: SpecialDay
  onChange: (day: SpecialDay) => void
  onRemove: () => void
}): React.JSX.Element {
  const closed = day.hours === null

  return (
    <div className="flex flex-wrap items-center gap-2 py-3">
      <Input
        type="date"
        aria-label="Fecha"
        className="w-40"
        value={day.date}
        onChange={(e) => onChange({ ...day, date: e.target.value })}
      />

      <Input
        aria-label="Motivo"
        placeholder="Motivo (opcional)"
        className="w-44"
        maxLength={80}
        value={day.label ?? ''}
        onChange={(e) => onChange({ ...day, label: e.target.value })}
      />

      <div className="flex items-center gap-2">
        <Switch
          id={`special-open-${day.date}`}
          checked={!closed}
          onCheckedChange={(open) => onChange({ ...day, hours: open ? OPEN_DEFAULT : null })}
        />
        <label htmlFor={`special-open-${day.date}`} className="text-sm">
          {closed ? 'Cerrado' : 'Abierto'}
        </label>
      </div>

      {day.hours && (
        <div className="flex items-center gap-2">
          <Input
            type="time"
            aria-label="Apertura"
            className="w-28"
            value={day.hours.open}
            onChange={(e) =>
              day.hours && onChange({ ...day, hours: { ...day.hours, open: e.target.value } })
            }
          />
          <span className="text-muted-foreground text-sm">a</span>
          <Input
            type="time"
            aria-label="Cierre"
            className="w-28"
            value={day.hours.close}
            onChange={(e) =>
              day.hours && onChange({ ...day, hours: { ...day.hours, close: e.target.value } })
            }
          />
        </div>
      )}

      <Button
        variant="ghost"
        size="icon"
        className="ml-auto"
        onClick={onRemove}
        aria-label={`Quitar ${day.date}`}
      >
        <Trash2 size={16} aria-hidden />
      </Button>
    </div>
  )
}
