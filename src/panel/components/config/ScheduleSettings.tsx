import { useState } from 'react'
import type { DayHours, DayKey, OperatingHours } from '../../api/types.js'
import { useSectionSave } from '../../hooks/useSettings.js'
import { DAY_KEYS, DAY_LABELS } from '../../lib/constants.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Switch } from '../ui/switch.js'
import { SettingsCard } from './SettingsCard.js'

// What a day becomes when the owner switches it back on. The server's schema
// only demands open < close; these are a starting point to edit, not a default
// applied behind anyone's back — the switch was just flipped deliberately.
const REOPENED_DAY: DayHours = { open: '09:00', close: '19:00' }

export function ScheduleSettings({ hours }: { hours: OperatingHours }): React.JSX.Element {
  const { save, saving, saved, error } = useSectionSave()
  const [draft, setDraft] = useState<OperatingHours>(hours)

  const dirty = JSON.stringify(draft) !== JSON.stringify(hours)

  const setDay = (day: DayKey, value: DayHours | null): void => {
    setDraft((prev) => ({ ...prev, [day]: value }))
  }

  return (
    <SettingsCard
      title="Horario de atención"
      description="Emma solo ofrece horarios dentro de esta grilla. Fuera de ella responde que están cerrados."
      onSave={() => save({ section: 'schedule', operatingHours: draft })}
      saving={saving}
      saved={saved}
      error={error}
      dirty={dirty}
    >
      <div className="flex flex-col divide-y divide-border">
        {DAY_KEYS.map((day) => (
          <DayRow key={day} day={day} value={draft[day]} onChange={(v) => setDay(day, v)} />
        ))}
      </div>
    </SettingsCard>
  )
}

function DayRow({
  day,
  value,
  onChange,
}: {
  day: DayKey
  value: DayHours | null
  onChange: (value: DayHours | null) => void
}): React.JSX.Element {
  const open = value !== null
  // Editing the break is opt-in per day: most days do not have one, and a pair
  // of empty time inputs on every row makes the grid unreadable.
  const hasBreak = value?.break !== undefined

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex w-32 items-center gap-2">
          <Switch
            id={`day-${day}`}
            checked={open}
            onCheckedChange={(checked) => onChange(checked ? REOPENED_DAY : null)}
          />
          <Label htmlFor={`day-${day}`}>{DAY_LABELS[day]}</Label>
        </div>

        {open && value ? (
          <div className="flex flex-wrap items-center gap-2">
            <TimeInput
              aria-label={`Apertura ${DAY_LABELS[day]}`}
              value={value.open}
              onChange={(open) => onChange({ ...value, open })}
            />
            <span className="text-muted-foreground text-sm">a</span>
            <TimeInput
              aria-label={`Cierre ${DAY_LABELS[day]}`}
              value={value.close}
              onChange={(close) => onChange({ ...value, close })}
            />
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground ml-1 text-xs underline underline-offset-4"
              onClick={() =>
                onChange(
                  hasBreak
                    ? { open: value.open, close: value.close }
                    : { ...value, break: { start: '13:00', end: '14:00' } },
                )
              }
            >
              {hasBreak ? 'Quitar descanso' : 'Agregar descanso'}
            </button>
          </div>
        ) : (
          <span className="text-muted-foreground text-sm">Cerrado</span>
        )}
      </div>

      {open && value?.break && (
        <div className="flex flex-wrap items-center gap-2 pl-32">
          <span className="text-muted-foreground text-xs">Descanso</span>
          <TimeInput
            aria-label={`Inicio del descanso ${DAY_LABELS[day]}`}
            value={value.break.start}
            onChange={(start) =>
              onChange({ ...value, break: { start, end: value.break?.end ?? start } })
            }
          />
          <span className="text-muted-foreground text-sm">a</span>
          <TimeInput
            aria-label={`Fin del descanso ${DAY_LABELS[day]}`}
            value={value.break.end}
            onChange={(end) =>
              onChange({ ...value, break: { start: value.break?.start ?? end, end } })
            }
          />
        </div>
      )}
    </div>
  )
}

function TimeInput({
  value,
  onChange,
  ...props
}: { value: string; onChange: (value: string) => void } & Omit<
  React.ComponentProps<typeof Input>,
  'value' | 'onChange' | 'type'
>): React.JSX.Element {
  return (
    <Input
      type="time"
      className="w-28"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...props}
    />
  )
}
