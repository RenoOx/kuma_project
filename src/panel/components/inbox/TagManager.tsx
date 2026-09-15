import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { PanelTag } from '../../api/types.js'
import { useTagMutation, useTags } from '../../hooks/useTags.js'
import { MAX_TAGS, TAG_COLORS, TAG_COLOR_META, type TagColor } from '../../lib/constants.js'
import { cn } from '../../lib/utils.js'
import { Button } from '../ui/button.js'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js'
import { Input } from '../ui/input.js'
import { Label } from '../ui/label.js'
import { TagBadge } from './TagBadge.js'

/**
 * Create, rename and delete the business's labels.
 *
 * Deleting is immediate and takes the label off every conversation carrying it
 * (the database cascades). Said plainly in the button's title rather than
 * behind a confirm dialog — a browser confirm blocks the whole panel, and
 * recreating a label is three seconds of work.
 */
export function TagManager({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}): React.JSX.Element {
  const { data: tags } = useTags()
  const { mutate, saving, error } = useTagMutation()

  const [name, setName] = useState('')
  const [color, setColor] = useState<TagColor>('emerald')

  const list = tags ?? []
  const atLimit = list.length >= MAX_TAGS

  const create = (): void => {
    const trimmed = name.trim()
    if (!trimmed) return
    mutate({ action: 'create', input: { name: trimmed, color } })
    setName('')
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Etiquetas</DialogTitle>
          <DialogDescription>
            Las que vos crees, para organizar tus conversaciones como te sirva.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-4 pb-4">
          {list.length > 0 && (
            <div className="flex flex-col divide-y divide-border">
              {list.map((tag) => (
                <TagRow
                  key={tag.id}
                  tag={tag}
                  onRename={(next) =>
                    next !== tag.name && mutate({ action: 'update', id: tag.id, input: { name: next } })
                  }
                  onDelete={() => mutate({ action: 'delete', id: tag.id })}
                />
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2 rounded-md border border-border p-3">
            <Label htmlFor="tag-name">Nueva etiqueta</Label>
            <Input
              id="tag-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && create()}
              placeholder="ej. VIP, Reclamo, Debe seña"
              maxLength={30}
              disabled={atLimit}
            />

            <div className="flex flex-wrap gap-1.5 pt-1">
              {TAG_COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`Color ${value}`}
                  aria-pressed={color === value}
                  onClick={() => setColor(value)}
                  disabled={atLimit}
                  className={cn(
                    'size-6 rounded-full transition-transform disabled:opacity-40',
                    TAG_COLOR_META[value].dotClassName,
                    color === value && 'ring-ring scale-110 ring-2 ring-offset-2 ring-offset-card',
                  )}
                />
              ))}
            </div>

            <Button
              size="sm"
              className="mt-1 w-fit"
              onClick={create}
              disabled={saving || atLimit || name.trim().length === 0}
            >
              <Plus size={14} aria-hidden />
              Agregar
            </Button>

            {atLimit && (
              <p className="text-muted-foreground text-xs">
                Llegaste a {MAX_TAGS} etiquetas. Borrá una para crear otra.
              </p>
            )}
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TagRow({
  tag,
  onRename,
  onDelete,
}: {
  tag: PanelTag
  onRename: (name: string) => void
  onDelete: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(tag.name)

  return (
    <div className="flex items-center gap-2 py-2">
      <TagBadge tag={tag} className="shrink-0" />
      <Input
        aria-label={`Nombre de ${tag.name}`}
        className="h-8 flex-1"
        value={draft}
        maxLength={30}
        onChange={(e) => setDraft(e.target.value)}
        // Committed on blur rather than per keystroke: one PATCH per rename,
        // not one per letter.
        onBlur={() => onRename(draft.trim() || tag.name)}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      <Button
        variant="ghost"
        size="icon"
        onClick={onDelete}
        aria-label={`Eliminar ${tag.name}`}
        title="Se quita de todas las conversaciones que la tengan"
      >
        <Trash2 size={16} aria-hidden />
      </Button>
    </div>
  )
}
