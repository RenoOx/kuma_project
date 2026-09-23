import { Plus, X } from 'lucide-react'
import { useState } from 'react'
import type { OutOfHoursBehavior, PanelSettings } from '../../api/types.js'
import { useSectionSave } from '../../hooks/useSettings.js'
import { Field, SettingsCard } from '../config/SettingsCard.js'
import { Badge } from '../ui/badge.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js'
import { Switch } from '../ui/switch.js'

const BEHAVIOR_LABELS: Record<OutOfHoursBehavior, string> = {
  keep_talking: 'Sigue conversando y toma los datos',
  greet_and_capture: 'Solo saluda y toma los datos',
}

// The five the spec lists as checkboxes. Stored in the same free-form array as the
// custom ones — one array, because a "standard" field and a custom one are the
// same thing to the bot, and two lists would only need reconciling.
const STANDARD_FIELDS = ['Nombre', 'Correo', 'Teléfono', 'Dirección', 'Fecha y hora'] as const

function splitFields(stored: string[]): { standard: string[]; custom: string[] } {
  const standard = STANDARD_FIELDS.filter((field) => stored.includes(field))
  const custom = stored.filter((field) => !STANDARD_FIELDS.includes(field as never))
  return { standard: [...standard], custom }
}

/**
 * The knobs that shape the conversation itself.
 *
 * Narrower than the spec's FLUJO table, and deliberately: the deposit and its
 * payment methods already have a card in Servicios, and the weekly hours have one
 * in Configuración. Rebuilding either here would give the owner two forms writing
 * one field. This card links to them instead and owns what had nowhere to live.
 */
export function FlowSettings({ data }: { data: PanelSettings }): React.JSX.Element {
  const { save, saving, saved, error } = useSectionSave()

  const config = data.settings
  const storedFields = config?.collectDataFields ?? []
  const initial = splitFields(storedFields)

  const [standard, setStandard] = useState<string[]>(initial.standard)
  const [custom, setCustom] = useState<string[]>(initial.custom)
  const [newField, setNewField] = useState('')
  const [outOfHoursEnabled, setOutOfHoursEnabled] = useState(config?.outOfHoursEnabled ?? false)
  const [behavior, setBehavior] = useState<OutOfHoursBehavior>(
    config?.outOfHoursBehavior ?? 'keep_talking',
  )
  const [attempts, setAttempts] = useState(String(config?.escalationAttempts ?? 3))
  const [keyword, setKeyword] = useState(config?.cancellationKeyword ?? 'cancelar')

  // Standards first in their canonical order, then the custom ones as typed, so a
  // save never reshuffles the list the owner is looking at.
  const collectDataFields = [
    ...STANDARD_FIELDS.filter((field) => standard.includes(field)),
    ...custom,
  ]

  const parsedAttempts = Number(attempts)
  const attemptsValid =
    Number.isInteger(parsedAttempts) && parsedAttempts >= 1 && parsedAttempts <= 10

  const dirty =
    JSON.stringify(collectDataFields) !== JSON.stringify(storedFields) ||
    outOfHoursEnabled !== (config?.outOfHoursEnabled ?? false) ||
    behavior !== (config?.outOfHoursBehavior ?? 'keep_talking') ||
    parsedAttempts !== (config?.escalationAttempts ?? 3) ||
    keyword !== (config?.cancellationKeyword ?? 'cancelar')

  const toggleStandard = (field: string, on: boolean): void => {
    setStandard(on ? [...standard, field] : standard.filter((f) => f !== field))
  }

  const addCustom = (): void => {
    const value = newField.trim()
    if (!value) return
    // Case-insensitive, because "DNI" and "dni" are one field to whoever reads the
    // list and two rows Emma would ask for twice.
    const exists = collectDataFields.some((f) => f.toLowerCase() === value.toLowerCase())
    if (!exists) setCustom([...custom, value])
    setNewField('')
  }

  const onSave = (): void => {
    save({
      section: 'flow',
      patch: {
        collectDataFields,
        outOfHoursEnabled,
        outOfHoursBehavior: behavior,
        escalationAttempts: parsedAttempts,
        cancellationKeyword: keyword.trim(),
      },
    })
  }

  return (
    <SettingsCard
      title="Flujo"
      description="Cómo lleva Emma la conversación. El adelanto y los métodos de pago se configuran en Servicios; los horarios, en Configuración."
      onSave={onSave}
      saving={saving}
      saved={saved}
      error={error}
      dirty={dirty && attemptsValid && keyword.trim().length > 0}
      readOnly
    >
      <Field
        label="Datos a capturar"
        hint="Qué le pide Emma al cliente. Hoy lo usa el flujo de ventas."
      >
        <div className="flex flex-col gap-2">
          {STANDARD_FIELDS.map((field) => {
            // Radix renders a button rather than a checkbox input, so the label has
            // to point at it by id — wrapping it does not associate the two.
            const id = `flow-field-${field.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
            return (
              <div key={field} className="flex items-center gap-2.5">
                <Switch
                  id={id}
                  checked={standard.includes(field)}
                  onCheckedChange={(on) => toggleStandard(field, on)}
                />
                <Label htmlFor={id} className="font-normal">
                  {field}
                </Label>
              </div>
            )
          })}
        </div>
      </Field>

      <Field label="Campos propios" hint="Cualquier otro dato que necesites del cliente.">
        <div className="flex flex-col gap-2">
          {custom.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {custom.map((field) => (
                <Badge key={field} variant="secondary" className="gap-1">
                  {field}
                  <button
                    type="button"
                    onClick={() => setCustom(custom.filter((f) => f !== field))}
                    aria-label={`Quitar ${field}`}
                    className="hover:text-destructive"
                  >
                    <X size={12} aria-hidden />
                  </button>
                </Badge>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <Input
              value={newField}
              onChange={(e) => setNewField(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // The card has no <form>, but Enter is what anyone typing into a
                  // box next to an Add button will press.
                  e.preventDefault()
                  addCustom()
                }
              }}
              maxLength={60}
              placeholder="ej. Tipo de tratamiento"
            />
            <Button type="button" variant="outline" size="sm" onClick={addCustom}>
              <Plus size={14} aria-hidden />
              Agregar
            </Button>
          </div>
        </div>
      </Field>

      <Field
        label="Respetar el horario de atención"
        hint="Activado, fuera de horario Emma sigue atendiendo pero no agenda ni cobra."
        htmlFor="flow-ooh"
      >
        <Switch id="flow-ooh" checked={outOfHoursEnabled} onCheckedChange={setOutOfHoursEnabled} />
      </Field>

      {outOfHoursEnabled && (
        <Field label="Fuera de horario" htmlFor="flow-ooh-behavior">
          <Select value={behavior} onValueChange={(v) => setBehavior(v as OutOfHoursBehavior)}>
            <SelectTrigger id="flow-ooh-behavior">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(BEHAVIOR_LABELS) as OutOfHoursBehavior[]).map((value) => (
                <SelectItem key={value} value={value}>
                  {BEHAVIOR_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      )}

      <Field
        label="Intentos antes de derivar"
        hint="Se guarda, pero todavía no se aplica: hoy Emma decide sola cuándo derivar."
        htmlFor="flow-attempts"
      >
        <div className="flex flex-col gap-1.5">
          <Badge variant="secondary" className="w-fit text-[10px]">
            Próximamente
          </Badge>
          <Input
            id="flow-attempts"
            type="number"
            inputMode="numeric"
            min={1}
            max={10}
            value={attempts}
            onChange={(e) => setAttempts(e.target.value)}
          />
          {!attemptsValid && (
            <span className="text-destructive text-xs">Tiene que ser entre 1 y 10.</span>
          )}
        </div>
      </Field>

      <Field
        label="Palabra para cancelar"
        hint="La usará el cliente para cancelar desde un recordatorio."
        htmlFor="flow-keyword"
      >
        <div className="flex flex-col gap-1.5">
          <Badge variant="secondary" className="w-fit text-[10px]">
            Próximamente
          </Badge>
          <Input
            id="flow-keyword"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            maxLength={40}
          />
        </div>
      </Field>
    </SettingsCard>
  )
}
