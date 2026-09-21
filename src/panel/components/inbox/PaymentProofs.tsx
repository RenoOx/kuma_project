import { ChevronDown, ChevronRight, ImageOff, Receipt } from 'lucide-react'
import { useState } from 'react'
import type { PaymentProof, PaymentProofStatus } from '../../api/types.js'
import { usePaymentProofs } from '../../hooks/usePaymentProofs.js'
import { cn, formatDateTime } from '../../lib/utils.js'

const STATUS_LABEL: Record<PaymentProofStatus, string> = {
  pending: 'En verificación',
  approved: 'Aprobado',
  rejected: 'Rechazado',
  superseded: 'Reemplazado',
}

const STATUS_CLASS: Record<PaymentProofStatus, string> = {
  pending: 'text-q-needs-info',
  approved: 'text-q-booked',
  rejected: 'text-destructive',
  superseded: 'text-muted-foreground',
}

/**
 * The deposit captures of a conversation, collapsed until asked for.
 *
 * Sits under the header rather than inside the transcript, because the capture
 * never was a message: the photo went to the owner's WhatsApp and the transcript
 * only ever carried a text stand-in for it. Threading it into the message stream
 * would put a picture at a timestamp no message has.
 *
 * Renders nothing when there are no captures — which is every conversation in a
 * business that does not ask for a deposit.
 */
export function PaymentProofs({
  conversationId,
}: {
  conversationId: string
}): React.JSX.Element | null {
  const { data } = usePaymentProofs(conversationId)
  const [open, setOpen] = useState(false)

  const proofs = data ?? []
  if (proofs.length === 0) return null

  return (
    <div className="shrink-0 border-b border-border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
      >
        {open ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
        <Receipt size={14} aria-hidden />
        <span>
          {proofs.length === 1 ? '1 comprobante de pago' : `${proofs.length} comprobantes de pago`}
        </span>
      </button>

      {open && (
        <div className="flex flex-col gap-2 px-3 pb-3">
          {proofs.map((proof) => (
            <ProofCard key={proof.id} proof={proof} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProofCard({ proof }: { proof: PaymentProof }): React.JSX.Element {
  return (
    <div className="bg-card flex items-start gap-3 rounded-lg border border-border p-2">
      {proof.proofUrl ? (
        // Opens the signed URL in a new tab: the thumbnail is too small to read an
        // amount off, which is the whole reason the owner is looking.
        <a
          href={proof.proofUrl}
          target="_blank"
          rel="noreferrer"
          className="shrink-0"
          aria-label={`Ver el comprobante de ${proof.customerName}`}
        >
          <img
            src={proof.proofUrl}
            alt=""
            className="size-16 rounded-md border border-border object-cover"
          />
        </a>
      ) : (
        <div className="bg-muted flex size-16 shrink-0 items-center justify-center rounded-md border border-border">
          <ImageOff className="text-muted-foreground" size={16} aria-hidden />
        </div>
      )}

      <div className="min-w-0 flex-1 text-xs">
        <p className="truncate font-medium text-foreground">
          {proof.service}
          {proof.depositAmount ? ` · ${proof.depositAmount}` : ''}
        </p>
        <p className="text-muted-foreground truncate">
          {proof.customerName} · cita {formatDateTime(proof.scheduledAt)}
        </p>
        <p className={cn('mt-0.5', STATUS_CLASS[proof.status])}>
          {STATUS_LABEL[proof.status]}
          {proof.rejectionReason ? `: ${proof.rejectionReason}` : ''}
        </p>
        {/* Only the archive is missing, never the decision — a capture from before
            storage existed still has a status the owner needs to see. */}
        {!proof.proofUrl && <p className="text-muted-foreground mt-0.5">Sin imagen archivada.</p>}
      </div>
    </div>
  )
}
