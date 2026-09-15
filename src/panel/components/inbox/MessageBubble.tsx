import { AlertCircle, Clock } from 'lucide-react'
import type { ChatMessage } from '../../api/types.js'
import { isPending } from '../../api/types.js'
import { cn, formatTime } from '../../lib/utils.js'
import { Button } from '../ui/button.js'

export function MessageBubble({
  message,
  ownerName,
  onRetry,
  onDismiss,
}: {
  message: ChatMessage
  ownerName: string | null
  onRetry: (localId: string) => void
  onDismiss: (localId: string) => void
}): React.JSX.Element {
  // The customer is the only side that sits on the left. Emma and the owner
  // both speak FOR the business, so they share the right — the label is what
  // separates them, and it is the whole reason sender_type exists.
  const fromCustomer = message.senderType === 'customer'
  const fromOwner = message.senderType === 'human'
  const pending = isPending(message)
  const failed = pending && message.failed === true

  const label = fromCustomer ? null : message.senderType === 'human' ? (ownerName ?? 'Tú') : 'Emma'

  return (
    <div className={cn('flex flex-col gap-1', fromCustomer ? 'items-start' : 'items-end')}>
      {label && <span className="text-muted-foreground px-1 text-[11px]">{label}</span>}

      {/* Three speakers, three surfaces, and each one carries its own text
          colour — the fill decides what can be read on it. The customer writes
          on the block surface in cream, Emma on her green in white, the owner
          on cream in near-black. That last inversion is the point: a human
          reply has to be distinguishable from Emma at a glance. */}
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm whitespace-pre-wrap md:max-w-[70%]',
          fromCustomer && 'bg-emma-elevated text-emma-text rounded-bl-sm border border-emma-border',
          !fromCustomer && !pending && !fromOwner && 'bg-emma-bubble-bot rounded-br-sm text-white',
          !fromCustomer &&
            !pending &&
            fromOwner &&
            'bg-emma-bubble-human text-emma-bg rounded-br-sm',
          pending && !failed && 'bg-secondary text-muted-foreground rounded-br-sm',
          failed && 'bg-destructive/15 text-emma-text border-destructive/50 rounded-br-sm border',
        )}
      >
        {message.content}
      </div>

      <span className="text-muted-foreground flex items-center gap-1 px-1 text-[11px]">
        {failed ? (
          <>
            <AlertCircle size={11} aria-hidden className="text-destructive" />
            <span className="text-destructive">No se envió</span>
            <Button
              variant="link"
              size="sm"
              onClick={() => onRetry(message.id)}
              className="text-muted-foreground hover:text-foreground h-auto p-0 text-[11px]"
            >
              Reintentar
            </Button>
            <Button
              variant="link"
              size="sm"
              onClick={() => onDismiss(message.id)}
              className="text-muted-foreground hover:text-foreground h-auto p-0 text-[11px]"
            >
              Descartar
            </Button>
          </>
        ) : pending ? (
          <>
            <Clock size={11} aria-hidden />
            Enviando…
          </>
        ) : (
          formatTime(message.createdAt)
        )}
      </span>
    </div>
  )
}
