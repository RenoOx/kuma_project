import { useState } from 'react'
import type { PanelService } from '../../api/types.js'
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
  error,
}: {
  open: boolean
  /** Null when creating. */
  service: PanelService | null
  onClose: () => void
  onSubmit: (service: PanelService) => void
  error: string | null
}): React.JSX.Element {
  const base = service ?? EMPTY

  const [name, setName] = useState(base.name)
  const [duration, setDuration] = useState(toField(base.durationMinutes))
  const [priceMin, setPriceMin] = useState(toField(base.priceMin))
  const [priceMax, setPriceMax] = useState(toField(base.priceMax))
  const [requiresEvaluation, setRequiresEvaluation] = useState(base.requiresEvaluation)
  const [referenceUrl, setReferenceUrl] = useState(base.referenceUrl ?? '')

  const submit = (): void => {
    const trimmedRef = referenceUrl.trim()
    onSubmit({
      ...base,
      name: name.trim(),
      durationMinutes: toNumber(duration),
      priceMin: toNumber(priceMin),
      priceMax: toNumber(priceMax),
      requiresEvaluation,
      // The link only means anything for an evaluation-first service, so it is
      // dropped when the switch is off — but it stays in the field above while
      // the dialog is open, so toggling back does not make the owner retype it.
      ...(requiresEvaluation && trimmedRef ? { referenceUrl: trimmedRef } : {}),
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

          {requiresEvaluation && (
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
