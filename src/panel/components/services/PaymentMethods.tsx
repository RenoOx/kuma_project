import { Plus, Trash2, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import type { BusinessSettingsView, DepositMethod, DepositPaymentMethod } from '../../api/types.js'
import { useKeyedDraft } from '../../hooks/useKeyedDraft.js'
import { useSectionSave } from '../../hooks/useSettings.js'
import { DEPOSIT_METHOD_LABELS, DEPOSIT_METHODS } from '../../lib/constants.js'
import { SettingsCard } from '../config/SettingsCard.js'
import { Button } from '../ui/button.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js'
import { Switch } from '../ui/switch.js'

export function PaymentMethods({
  settings,
}: {
  settings: BusinessSettingsView
}): React.JSX.Element {
  const { save, saving, saved, error } = useSectionSave()

  const [requiresDeposit, setRequiresDeposit] = useState(settings.requiresDeposit)
  const [amount, setAmount] = useState(settings.depositAmount ?? '')
  const {
    rows: methodRows,
    values: methods,
    add: addMethod,
    update: updateMethod,
    remove: removeMethod,
  } = useKeyedDraft<DepositPaymentMethod>(settings.depositPaymentMethods)

  const dirty =
    requiresDeposit !== settings.requiresDeposit ||
    amount !== (settings.depositAmount ?? '') ||
    JSON.stringify(methods) !== JSON.stringify(settings.depositPaymentMethods)

  const onSave = (): void => {
    save({
      section: 'payments',
      patch: {
        requiresDeposit,
        // Empty clears it. depositAmount is optional on the server, so an empty
        // string would be a stored blank nothing ever reads.
        ...(amount.trim() ? { depositAmount: amount.trim() } : {}),
        depositPaymentMethods: methods,
      },
    })
  }

  return (
    <SettingsCard
      title="Formas de pago"
      description="Los datos que Emma le pasa al cliente cuando toca pagar."
      onSave={onSave}
      saving={saving}
      saved={saved}
      error={error}
      dirty={dirty}
      readOnly
    >
      {methods.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No hay formas de pago cargadas. Emma va a decir que no las tiene configuradas.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border">
          {methodRows.map(({ key, value: method }, index) => (
            <MethodRow
              key={key}
              method={method}
              onChange={(next) => updateMethod(index, next)}
              onRemove={() => removeMethod(index)}
            />
          ))}
        </div>
      )}

      <div>
        <Button variant="outline" size="sm" onClick={() => addMethod({ method: 'yape' })}>
          <Plus size={14} aria-hidden />
          Agregar forma de pago
        </Button>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-border p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-col gap-0.5">
            <Label htmlFor="pay-deposit">Pedir adelanto para reservar</Label>
            <span className="text-muted-foreground text-xs">
              Emma pide el comprobante antes de confirmar la cita.
            </span>
          </div>
          <Switch id="pay-deposit" checked={requiresDeposit} onCheckedChange={setRequiresDeposit} />
        </div>

        {/* Two consequences the owner cannot deduce from the switch: Emma stops
            closing bookings on her own, and photo forwarding turns on whatever
            the other toggle says. Said before it is flipped, not after. */}
        {requiresDeposit && (
          <div className="bg-q-needs-info/10 flex items-start gap-2 rounded-md p-2.5">
            <TriangleAlert className="text-q-needs-info mt-0.5 shrink-0" size={14} aria-hidden />
            <p className="text-xs">
              Con el adelanto activo, Emma <strong>no agenda sola</strong>: le pide la captura al
              cliente y vos aprobás desde tu WhatsApp. Además te reenvía las fotos que manden,
              aunque el reenvío esté apagado en Configuración.
            </p>
          </div>
        )}

        {requiresDeposit && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pay-amount">Monto del adelanto</Label>
            <Input
              id="pay-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="ej. S/ 20, el 50%, S/ 20 por persona"
              maxLength={120}
            />
            <span className="text-muted-foreground text-xs">
              Texto libre: Emma lo repite tal cual lo escribas.
            </span>
          </div>
        )}
      </div>
    </SettingsCard>
  )
}

function MethodRow({
  method,
  onChange,
  onRemove,
}: {
  method: DepositPaymentMethod
  onChange: (method: DepositPaymentMethod) => void
  onRemove: () => void
}): React.JSX.Element {
  // Cash has no number to type. The field is dropped rather than shown empty.
  const needsNumber = method.method !== 'efectivo'

  return (
    <div className="flex flex-wrap items-center gap-2 py-3">
      <Select
        value={method.method}
        onValueChange={(value) => onChange({ ...method, method: value as DepositMethod })}
      >
        <SelectTrigger className="w-40" aria-label="Forma de pago">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DEPOSIT_METHODS.map((value) => (
            <SelectItem key={value} value={value}>
              {DEPOSIT_METHOD_LABELS[value]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {needsNumber && (
        <Input
          aria-label="Número"
          className="w-44"
          inputMode="tel"
          placeholder="Número"
          value={method.number ?? ''}
          onChange={(e) => onChange({ ...method, number: e.target.value })}
        />
      )}

      <Input
        aria-label="A nombre de"
        className="w-44"
        placeholder="A nombre de (opcional)"
        value={method.label ?? ''}
        onChange={(e) => onChange({ ...method, label: e.target.value })}
      />

      <Button
        variant="ghost"
        size="icon"
        className="ml-auto"
        onClick={onRemove}
        aria-label={`Quitar ${DEPOSIT_METHOD_LABELS[method.method]}`}
      >
        <Trash2 size={16} aria-hidden />
      </Button>
    </div>
  )
}
