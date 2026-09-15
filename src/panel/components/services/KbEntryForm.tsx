import { useState } from 'react'
import type {
  KbAttachmentType,
  KbCategory,
  KbSendMode,
  KnowledgeEntry,
  KnowledgeInput,
} from '../../api/types.js'
import {
  KB_ATTACHMENT_TYPE_LABELS,
  KB_CATEGORIES,
  KB_CATEGORY_LABELS,
  KB_SEND_MODE_LABELS,
} from '../../lib/constants.js'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js'
import { Textarea } from '../ui/textarea.js'

const SEND_MODES: KbSendMode[] = ['always', 'on_request', 'trigger_based']
const ATTACHMENT_TYPES: KbAttachmentType[] = ['none', 'link', 'image', 'pdf', 'video']

export function KbEntryForm({
  open,
  entry,
  onClose,
  onSubmit,
  saving,
  error,
}: {
  open: boolean
  /** Null when creating. */
  entry: KnowledgeEntry | null
  onClose: () => void
  onSubmit: (input: KnowledgeInput) => void
  saving: boolean
  error: string | null
}): React.JSX.Element {
  const [title, setTitle] = useState(entry?.title ?? '')
  const [category, setCategory] = useState<KbCategory>(entry?.category ?? 'informacion_general')
  const [content, setContent] = useState(entry?.content ?? '')
  const [sendMode, setSendMode] = useState<KbSendMode>(entry?.sendMode ?? 'on_request')
  const [keywords, setKeywords] = useState((entry?.triggerKeywords ?? []).join(', '))
  const [attachmentType, setAttachmentType] = useState<KbAttachmentType>(
    entry?.attachmentType ?? 'none',
  )
  const [attachmentUrl, setAttachmentUrl] = useState(entry?.attachmentUrl ?? '')
  const [active, setActive] = useState(entry?.active ?? true)

  const parsedKeywords = keywords
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)

  const submit = (): void => {
    onSubmit({
      // An empty title means "derive it from the content", which the server
      // does. Sending '' on an edit would blank a title the owner had set.
      ...(title.trim() ? { title: title.trim() } : {}),
      category,
      content: content.trim(),
      // sendMode always travels with triggerKeywords: the service nulls the
      // keywords when it gets them without a mode alongside.
      sendMode,
      triggerKeywords: sendMode === 'trigger_based' ? parsedKeywords : null,
      attachmentType,
      attachmentUrl: attachmentType === 'none' ? null : attachmentUrl.trim(),
      active,
    })
  }

  const incomplete =
    content.trim().length === 0 ||
    (attachmentType !== 'none' && attachmentUrl.trim().length === 0) ||
    (sendMode === 'trigger_based' && parsedKeywords.length === 0)

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{entry ? 'Editar información' : 'Nueva información'}</DialogTitle>
          <DialogDescription>
            Lo que Emma necesita saber y no está en la configuración del negocio.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-category">Categoría</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as KbCategory)}>
              <SelectTrigger id="kb-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KB_CATEGORIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {KB_CATEGORY_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-title">Título</Label>
            <Input
              id="kb-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Si lo dejás vacío, lo sacamos del texto"
              maxLength={120}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-content">Contenido</Label>
            <Textarea
              id="kb-content"
              rows={6}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Escribilo como se lo contarías a un cliente."
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-mode">Cuándo lo usa Emma</Label>
            <Select value={sendMode} onValueChange={(v) => setSendMode(v as KbSendMode)}>
              <SelectTrigger id="kb-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEND_MODES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {KB_SEND_MODE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-muted-foreground text-xs">
              {sendMode === 'always' && 'Entra en todas las conversaciones.'}
              {sendMode === 'on_request' && 'Solo cuando el cliente pregunta por ese tema.'}
              {sendMode === 'trigger_based' && 'Solo cuando el mensaje incluye alguna palabra.'}
            </span>
          </div>

          {sendMode === 'trigger_based' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kb-keywords">Palabras clave</Label>
              <Input
                id="kb-keywords"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="separadas, por, comas"
              />
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kb-attachment">Adjunto</Label>
            <Select
              value={attachmentType}
              onValueChange={(v) => setAttachmentType(v as KbAttachmentType)}
            >
              <SelectTrigger id="kb-attachment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ATTACHMENT_TYPES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {KB_ATTACHMENT_TYPE_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {attachmentType !== 'none' && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="kb-url">Link del adjunto</Label>
              <Input
                id="kb-url"
                type="url"
                inputMode="url"
                value={attachmentUrl}
                onChange={(e) => setAttachmentUrl(e.target.value)}
                placeholder="https://…"
              />
            </div>
          )}

          <div className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor="kb-active">Activa</Label>
              <span className="text-muted-foreground text-xs">
                Desactivarla la saca de Emma sin borrarla.
              </span>
            </div>
            <Switch id="kb-active" checked={active} onCheckedChange={setActive} />
          </div>

          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <DialogFooter className="px-4">
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={submit} disabled={incomplete || saving}>
            {saving ? 'Guardando…' : entry ? 'Guardar' : 'Agregar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
