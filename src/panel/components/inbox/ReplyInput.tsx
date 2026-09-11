import { Send } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../ui/button.js'
import { Textarea } from '../ui/textarea.js'

export function ReplyInput({
  ownerName,
  disabled,
  onSend,
}: {
  ownerName: string | null
  disabled: boolean
  onSend: (text: string) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const canSend = text.trim().length > 0 && !disabled

  const submit = (): void => {
    if (!canSend) return
    onSend(text.trim())
    setText('')
  }

  return (
    <form
      // The bar keeps the chat's own fill so the field sitting on it — one step
      // lighter, ringed in the same border as everything else — reads as the
      // thing you type into.
      className="bg-emma-bg flex shrink-0 items-end gap-2 border-t border-border p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends, Shift+Enter breaks the line — the convention every
          // chat app has trained people into. Without this the owner types a
          // second line and accidentally sends half a message to a customer.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit()
          }
        }}
        rows={1}
        placeholder={`Responder como ${ownerName ?? 'vos'}…`}
        aria-label="Escribir respuesta"
        className="max-h-32 min-h-[38px] flex-1 resize-y py-2"
      />
      <Button
        type="submit"
        size="icon"
        disabled={!canSend}
        aria-label="Enviar"
        className="size-[38px]"
      >
        <Send size={16} aria-hidden />
      </Button>
    </form>
  )
}
