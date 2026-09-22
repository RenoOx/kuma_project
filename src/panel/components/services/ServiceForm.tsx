import { useState } from 'react'
import type { PanelService } from '../../api/types.js'
import { MediaField } from '../media/MediaField.js'
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
import { Switch } from '../ui/switch.js'
import { Textarea } from '../ui/textarea.js'

const EMPTY: PanelService = {
  name: '',
  durationMinutes: null,
  priceMin: null,
  priceMax: null,
  requiresEvaluation: false,
  active: true,
}

function toField(value: number | null): string {
  return value === null ? '' : String(value)
}

function toNumber(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Create / edit one service.
 *
 * Validation is left to the server: `serviceSchema` already encodes that a
 * price is required unless the service needs an evaluation, and that max must
 * not be below min. Re-implementing those here would be a second copy to keep
 * in sync. What this form does is make the invalid states hard to reach and
 * show the server's complaint when one gets through.
 */
export function ServiceForm({
  open,
  service,
  onClose,
  onSubmit,
  schedulesAppointments,
  knownCategories,
  error,
}: {
  open: boolean
  /** Null when creating. */
  service: PanelService | null
  onClose: () => void
  onSubmit: (service: PanelService) => void
  /**
   * False for a business that sells instead of booking. The duration field is
   * hidden entirely rather than left blank: asking how many minutes a course
   * lasts invites an answer nothing will ever read, and a field the owner has
   * to guess at is worse than one that is not there.
   */
  schedulesAppointments: boolean
  /** Categories the other services already use, offered as suggestions. */
  knownCategories: string[]
  error: string | null
}): React.JSX.Element {
  const base = service ?? EMPTY

  const [name, setName] = useState(base.name)
  const [description, setDescription] = useState(base.description ?? '')
  const [category, setCategory] = useState(base.category ?? '')
  const [duration, setDuration] = useState(toField(base.durationMinutes))
  const [priceMin, setPriceMin] = useState(toField(base.priceMin))
  const [priceMax, setPriceMax] = useState(toField(base.priceMax))
  const [requiresEvaluation, setRequiresEvaluation] = useState(base.requiresEvaluation)
  const [referenceUrl, setReferenceUrl] = useState(base.referenceUrl ?? '')

  // Re-seeded whenever the dialog is pointed at a different service.
  //
  // The six useState calls above run once, and this Dialog is never unmounted —
  // ServiceList renders it always and only toggles `open`. So opening "Nuevo
  // servicio" and then editing a real one left the fields holding the blank
  // values from the first open, while the title and the id — read straight from
  // props — showed the real service. An owner saving from that state was
  // handing back a service with no name and no price.
  //
  // Keyed on the service's own content, not on `open`: a parent re-render while
  // the dialog sits open must not wipe what is being typed.
  const seed = JSON.stringify(service)
  const [seededFrom, setSeededFrom] = useState(seed)
  if (seededFrom !== seed) {
    setSeededFrom(seed)
    setName(base.name)
    setDescription(base.description ?? '')
    setCategory(base.category ?? '')
    setDuration(toField(base.durationMinutes))
    setPriceMin(toField(base.priceMin))
    setPriceMax(toField(base.priceMax))
    setRequiresEvaluation(base.requiresEvaluation)
    setReferenceUrl(base.referenceUrl ?? '')
  }

  const submit = (): void => {
    const trimmedRef = referenceUrl.trim()
    const trimmedDescription = description.trim()
    onSubmit({
      ...base,
      name: name.trim(),
      // Dropped when empty rather than sent as '': the key has to be absent for
      // the server to read it as "never wrote one", and `...base` above would
      // otherwise keep a previous description alive after the owner cleared it.
      ...(trimmedDescription ? { description: trimmedDescription } : { description: undefined }),
      // Same rule as the description: cleared means absent, not ''. Leaving ''
      // would make this service its own group of one.
      ...(category.trim() ? { category: category.trim() } : { category: undefined }),
      durationMinutes: toNumber(duration),
      priceMin: toNumber(priceMin),
      priceMax: toNumber(priceMax),
      // Forced off for a business with no agenda, whatever a previous save left
      // stored: "requiere evaluación previa" means "we price it after seeing the
      // case, come in for a consultation", and a consultation is an appointment.
      // Saving from this form is what clears it on a business that switched.
      requiresEvaluation: schedulesAppointments && requiresEvaluation,
      // The link only means anything for an evaluation-first service, so it is
      // dropped when the switch is off — but it stays in the field above while
      // the dialog is open, so toggling back does not make the owner retype it.
      ...(schedulesAppointments && requiresEvaluation && trimmedRef
        ? { referenceUrl: trimmedRef }
        : {}),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{service ? 'Editar servicio' : 'Nuevo servicio'}</DialogTitle>
          <DialogDescription>
            Así se lo cuenta Emma a tus clientes cuando preguntan qué ofrecés.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="svc-name">Nombre</Label>
            <Input
              id="svc-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ej. Corte de cabello"
              maxLength={120}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="svc-description">Descripción</Label>
            <Textarea
              id="svc-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={600}
              rows={3}
              placeholder="Qué incluye, a quién le sirve, cuánto dura, qué se lleva…"
            />
            <span className="text-muted-foreground text-xs">
              Es lo que Emma cuenta cuando el cliente pide más información. Sin esto solo puede
              repetir el precio.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="svc-category">Categoría</Label>
            <Input
              id="svc-category"
              list="svc-category-options"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              maxLength={40}
              placeholder="ej. Nivel inicial"
            />
            {/* Suggestions, not a closed list: each business names its own
                groups. Offering the ones already in use is what keeps "Nivel
                inicial" and "nivel basico" from becoming two groups. */}
            <datalist id="svc-category-options">
              {knownCategories.map((option) => (
                <option key={option} value={option} />
              ))}
            </datalist>
            <span className="text-muted-foreground text-xs">
              Opcional. Con dos o más categorías distintas, Emma agrupa el catálogo en vez de
              listarlo plano.
            </span>
          </div>

          {schedulesAppointments && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="svc-duration">Duración (minutos)</Label>
              <Input
                id="svc-duration"
                type="number"
                inputMode="numeric"
                min={5}
                max={480}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder="Vacío = usa la duración por defecto"
              />
            </div>
          )}

          {/* Gone for a business with no agenda, like the duration above. The
              switch means "no cerramos precio hasta verlo, vení a una consulta"
              — and the consultation it sends the customer to is an appointment
              this business does not take. */}
          {schedulesAppointments && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="svc-eval">Requiere evaluación previa</Label>
                <span className="text-muted-foreground text-xs">
                  Emma no da un precio cerrado; dice que hay que verlo antes.
                </span>
              </div>
              <Switch
                id="svc-eval"
                checked={requiresEvaluation}
                onCheckedChange={setRequiresEvaluation}
              />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="svc-min">Precio mínimo (S/)</Label>
              <Input
                id="svc-min"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={priceMin}
                onChange={(e) => setPriceMin(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="svc-max">Precio máximo (S/)</Label>
              <Input
                id="svc-max"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={priceMax}
                onChange={(e) => setPriceMax(e.target.value)}
                placeholder="Vacío = desde el mínimo"
              />
            </div>
          </div>

          {schedulesAppointments && requiresEvaluation && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="svc-ref">Link de referencia</Label>
              <Input
                id="svc-ref"
                type="url"
                inputMode="url"
                value={referenceUrl}
                onChange={(e) => setReferenceUrl(e.target.value)}
                placeholder="Canva, Drive, portafolio…"
              />
              <span className="text-muted-foreground text-xs">
                Emma lo comparte para que vean ejemplos antes de cotizar.
              </span>
            </div>
          )}

          {/* Last, and with its own persistence: everything above is a draft
              until Guardar, while the photo is written the moment it is picked. */}
          <MediaField
            owner={base.id === undefined ? undefined : { kind: 'service', id: base.id }}
            label="Material del servicio"
            unsavedHint="Guardá el servicio primero y volvé a abrirlo para subirle archivos."
          />

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter className="px-4">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={name.trim().length === 0}>
            {service ? 'Guardar' : 'Agregar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
