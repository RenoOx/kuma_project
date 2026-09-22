import { Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { PanelService } from '../../api/types.js'
import { useKeyedDraft } from '../../hooks/useKeyedDraft.js'
import { useSectionSave } from '../../hooks/useSettings.js'
import { cn, formatServicePrice, pricedInTheDescription } from '../../lib/utils.js'
import { SettingsCard } from '../config/SettingsCard.js'
import { Button } from '../ui/button.js'
import { Switch } from '../ui/switch.js'
import { ServiceForm } from './ServiceForm.js'

/**
 * The service catalogue.
 *
 * The whole list is sent on save, like specialDays: the UI owns it and hands it
 * back entire, and the server reconciles ids against what it stored. The draft
 * lives here until the owner saves it.
 *
 * Files are the exception to that draft: they are owned by their own endpoints
 * and written as soon as one is picked — see ServiceMediaField.
 */
export function ServiceList({
  services,
  schedulesAppointments,
}: {
  services: PanelService[]
  /**
   * False for a business that sells instead of booking. Duration only means
   * something when a service occupies a slot — on a course or a certification
   * it is a field with no answer, and "Sin duración fija" reads like something
   * is missing rather than like something that does not apply.
   */
  schedulesAppointments: boolean
}): React.JSX.Element {
  const { save, saving, saved, error } = useSectionSave()
  const { rows, values: draft, add, update, remove } = useKeyedDraft<PanelService>(services)
  const [editing, setEditing] = useState<{ index: number | null } | null>(null)

  const dirty = JSON.stringify(draft) !== JSON.stringify(services)
  const activeCount = draft.filter((s) => s.active).length

  const submit = (service: PanelService): void => {
    if (editing === null || editing.index === null) add(service)
    else update(editing.index, service)
    setEditing(null)
  }

  return (
    <>
      <SettingsCard
        title="Servicios"
        description="Lo que Emma ofrece y cotiza. Un servicio desactivado no se menciona ni se puede agendar."
        onSave={() => save({ section: 'services', services: draft })}
        saving={saving}
        saved={saved}
        error={error}
        dirty={dirty}
      >
        {draft.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No hay servicios cargados. Emma no puede cotizar ni agendar sin al menos uno.
          </p>
        ) : (
          <div className="flex flex-col divide-y divide-border">
            {rows.map(({ key, value: service }, index) => (
              <ServiceRow
                key={key}
                service={service}
                schedulesAppointments={schedulesAppointments}
                onToggle={(active) => update(index, { ...service, active })}
                onEdit={() => setEditing({ index })}
                onRemove={() => remove(index)}
              />
            ))}
          </div>
        )}

        {/* The server refuses a catalogue with nothing active, so say it here
            rather than letting the save come back as a 400. */}
        {draft.length > 0 && activeCount === 0 && (
          <p className="text-destructive text-sm">
            Al menos un servicio tiene que estar activo. Emma se queda sin nada que ofrecer.
          </p>
        )}

        <div>
          <Button variant="outline" size="sm" onClick={() => setEditing({ index: null })}>
            <Plus size={14} aria-hidden />
            Agregar servicio
          </Button>
        </div>
      </SettingsCard>

      <ServiceForm
        open={editing !== null}
        service={
          editing?.index === null || editing === null ? null : (draft[editing.index] ?? null)
        }
        onClose={() => setEditing(null)}
        onSubmit={submit}
        schedulesAppointments={schedulesAppointments}
        // Every category already in use, so the form can offer them instead of
        // letting the owner retype one and split a group in two.
        knownCategories={[
          ...new Set(draft.map((s) => s.category?.trim()).filter((c): c is string => !!c)),
        ]}
        error={null}
      />
    </>
  )
}

function ServiceRow({
  service,
  schedulesAppointments,
  onToggle,
  onEdit,
  onRemove,
}: {
  service: PanelService
  schedulesAppointments: boolean
  onToggle: (active: boolean) => void
  onEdit: () => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3 py-3">
      <Switch
        checked={service.active}
        onCheckedChange={onToggle}
        aria-label={`${service.active ? 'Desactivar' : 'Activar'} ${service.name}`}
      />

      <div className={cn('min-w-0 flex-1', !service.active && 'opacity-50')}>
        <p className="truncate text-sm font-medium">{service.name}</p>
        <p className="text-muted-foreground truncate text-xs">
          {schedulesAppointments &&
            `${service.durationMinutes === null ? 'Sin duración fija' : `${service.durationMinutes} min`} · `}
          {formatServicePrice(service)}
          {pricedInTheDescription(service) && (
            <span className="text-q-needs-info"> · revisá el precio</span>
          )}
          {/* A flag, not a thumbnail. Showing the photo here would mean signing a
              URL per service on every page load; the preview lives in the edit
              dialog, where the owner actually asked to see it. */}
        </p>
      </div>

      <div className="flex items-center">
        <Button variant="ghost" size="icon" onClick={onEdit} aria-label={`Editar ${service.name}`}>
          <Pencil size={16} aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label={`Eliminar ${service.name}`}
        >
          <Trash2 size={16} aria-hidden />
        </Button>
      </div>
    </div>
  )
}
