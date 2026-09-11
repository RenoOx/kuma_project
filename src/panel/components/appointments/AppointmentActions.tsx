import { useState } from 'react'
import type { PanelAppointment } from '../../api/types.js'
import { useAppointmentAction } from '../../hooks/useAppointments.js'
import { Button } from '../ui/button.js'
import { Textarea } from '../ui/textarea.js'

/**
 * What the owner can do to an appointment, given where it already is.
 *
 * Pending is the only state with a decision waiting; a live booking can be
 * completed or called off; anything already finished or cancelled is history
 * and offers nothing. The reason box only appears for the two actions that
 * send the customer an explanation.
 */
export function AppointmentActions({
  appointment,
  onDone,
}: {
  appointment: PanelAppointment
  onDone: () => void
}): React.JSX.Element | null {
  const action = useAppointmentAction()
  const [reason, setReason] = useState('')
  const [asking, setAsking] = useState<'reject' | 'cancel' | null>(null)

  const status = appointment.status
  const isOpen = status === 'scheduled' || status === 'confirmed'

  if (status === 'completed' || status === 'cancelled') return null

  const run = (next: 'approve' | 'reject' | 'cancel' | 'complete'): void => {
    action.mutate(
      { id: appointment.id, action: next, ...(reason.trim() ? { reason: reason.trim() } : {}) },
      { onSuccess: onDone },
    )
  }

  if (asking) {
    return (
      <div className="space-y-2">
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="Motivo (opcional) — se lo enviamos al cliente"
          aria-label="Motivo"
        />
        <div className="flex gap-2">
          <Button
            variant="destructive"
            size="sm"
            disabled={action.isPending}
            onClick={() => run(asking)}
            className="flex-1"
          >
            {action.isPending
              ? 'Enviando…'
              : asking === 'reject'
                ? 'Confirmar rechazo'
                : 'Confirmar cancelación'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={action.isPending}
            onClick={() => setAsking(null)}
          >
            Volver
          </Button>
        </div>
        {action.isError && <ActionError />}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        {status === 'pending' && (
          <>
            <Button
              size="sm"
              disabled={action.isPending}
              onClick={() => run('approve')}
              className="flex-1"
            >
              {action.isPending ? 'Aprobando…' : 'Aprobar'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => setAsking('reject')}
              className="flex-1"
            >
              Rechazar
            </Button>
          </>
        )}

        {isOpen && (
          <>
            <Button
              size="sm"
              disabled={action.isPending}
              onClick={() => run('complete')}
              className="flex-1"
            >
              {action.isPending ? 'Guardando…' : 'Completar'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={action.isPending}
              onClick={() => setAsking('cancel')}
              className="flex-1"
            >
              Cancelar
            </Button>
          </>
        )}
      </div>

      {status === 'pending' && (
        <p className="text-muted-foreground text-xs">
          Aprobar le confirma la cita al cliente por WhatsApp. Completar no le envía nada.
        </p>
      )}
      {action.isError && <ActionError />}
    </div>
  )
}

function ActionError(): React.JSX.Element {
  return <p className="text-destructive text-xs">No pudimos aplicar el cambio. Intentá de nuevo.</p>
}
