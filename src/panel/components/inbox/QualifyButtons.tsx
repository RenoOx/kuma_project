import { Check, X } from 'lucide-react'
import type { PanelTag } from '../../api/types.js'
import { useQualify } from '../../hooks/useTags.js'
import { QUALIFICATION_TAG_NAMES, TAG_COLOR_META } from '../../lib/constants.js'
import { cn } from '../../lib/utils.js'
import { Button } from '../ui/button.js'

/**
 * Califica un lead que quedó "Por validar" — la etiqueta que el sistema le pone
 * a un chat cuando Emma se pausa porque llegó la captura de pago o el DNI.
 *
 * Solo aparece mientras el chat tenga "Por validar": un click la cambia por
 * "Pagó" o "No pagó" y los botones se van. Corregir después un resultado es con
 * el selector de etiquetas de siempre, que está al lado.
 */
export function QualifyButtons({
  conversationId,
  tags,
}: {
  conversationId: string
  tags: PanelTag[]
}): React.JSX.Element | null {
  const { qualify, pending, error } = useQualify(conversationId)

  if (!tags.some((tag) => tag.name === QUALIFICATION_TAG_NAMES.pending)) return null

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <Button
        variant="outline"
        size="sm"
        disabled={pending !== null}
        onClick={() => qualify('paid')}
        className={cn('h-7 border-transparent px-2 text-xs', TAG_COLOR_META.emerald.className)}
      >
        <Check size={13} aria-hidden />
        {pending === 'paid' ? 'Guardando…' : QUALIFICATION_TAG_NAMES.paid}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={pending !== null}
        onClick={() => qualify('not_paid')}
        className={cn('h-7 border-transparent px-2 text-xs', TAG_COLOR_META.rose.className)}
      >
        <X size={13} aria-hidden />
        {pending === 'not_paid' ? 'Guardando…' : QUALIFICATION_TAG_NAMES.not_paid}
      </Button>
      {error && (
        <span role="alert" title={error} className="text-destructive max-w-40 truncate text-xs">
          {error}
        </span>
      )}
    </div>
  )
}
