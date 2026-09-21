import {
  ChevronDown,
  ChevronUp,
  FileAudio,
  FileText,
  FileVideo,
  ImageOff,
  Trash2,
  Upload,
} from 'lucide-react'
import { useRef } from 'react'
import type { ServiceMediaType, ServiceMediaView } from '../../api/types.js'
import { useServiceMedia } from '../../hooks/useServiceMedia.js'
import { useSettings } from '../../hooks/useSettings.js'
import { Button } from '../ui/button.js'
import { Label } from '../ui/label.js'

const ACCEPT =
  'image/jpeg,image/png,image/webp,application/pdf,audio/mpeg,audio/wav,audio/ogg,video/mp4'

const TYPE_LABEL: Record<ServiceMediaType, string> = {
  image: 'Imagen',
  pdf: 'PDF',
  audio: 'Audio',
  video: 'Video',
}

/**
 * The files a service carries: photos, a price list, a voice note, a demo.
 *
 * Unlike every other field in this dialog, this one writes immediately: the file
 * goes to storage and its row to the database the moment it is picked, rather
 * than waiting for Guardar. Holding a 16MB video in memory until an unrelated
 * save would be worse, and the copy says which of the two is happening.
 *
 * Disabled with a reason in the two cases where an upload cannot work at all: a
 * service that was never saved has no id for its files to hang off, and a deploy
 * with no S3 credentials has nowhere to put them. Both are explained rather than
 * silently greyed out.
 */
export function ServiceMediaField({
  serviceId,
}: {
  /** Undefined while the service is being created — it has no id yet. */
  serviceId: string | undefined
}): React.JSX.Element {
  const settings = useSettings()
  const media = useServiceMedia(serviceId)
  const input = useRef<HTMLInputElement>(null)

  const mediaConfigured = settings.data?.mediaConfigured ?? false
  const unsaved = serviceId === undefined
  const blocked = unsaved || !mediaConfigured
  const disabled = blocked || media.busy

  const hint = unsaved
    ? 'Guardá el servicio primero y volvé a abrirlo para subirle archivos.'
    : !mediaConfigured
      ? 'El almacenamiento todavía no está configurado. Escribinos a Vamvu Labs.'
      : 'Se guardan al instante, sin esperar a Guardar. Imagen o audio hasta 5MB, PDF hasta 10MB, video hasta 16MB.'

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="svc-media">Material del servicio</Label>

      {media.items.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {media.items.map((item, index) => (
            <MediaRow
              key={item.id}
              item={item}
              first={index === 0}
              last={index === media.items.length - 1}
              disabled={disabled}
              onUp={() => media.move(item.id, -1)}
              onDown={() => media.move(item.id, 1)}
              onRemove={() => media.remove(item.id)}
            />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          <Upload size={14} aria-hidden />
          Agregar archivo
        </Button>
        <span className="text-muted-foreground text-xs">{media.busy ? 'Guardando…' : hint}</span>
      </div>

      {media.items.length > 1 && (
        // Said out loud because the order is not decorative: the executor caps
        // how many files one reply may carry, and the cut is taken from the top.
        <p className="text-muted-foreground text-xs">
          Emma manda los dos primeros de la lista. Usá las flechas para elegir cuáles.
        </p>
      )}

      <input
        ref={input}
        id="svc-media"
        type="file"
        accept={ACCEPT}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) media.upload(file)
          // Cleared so picking the same file again still fires a change event —
          // which is exactly what a retry after a failed upload looks like.
          e.target.value = ''
        }}
      />

      {media.error && <p className="text-destructive text-sm">{media.error}</p>}
    </div>
  )
}

function MediaRow({
  item,
  first,
  last,
  disabled,
  onUp,
  onDown,
  onRemove,
}: {
  item: ServiceMediaView
  first: boolean
  last: boolean
  disabled: boolean
  onUp: () => void
  onDown: () => void
  onRemove: () => void
}): React.JSX.Element {
  return (
    <li className="flex items-center gap-2 rounded-md border border-border p-2">
      <div className="bg-muted flex size-12 shrink-0 items-center justify-center overflow-hidden rounded">
        {/* A thumbnail only where one means something. A video preview is heavy
            for a dialog and a PDF has nothing to show — an icon reads faster. */}
        {item.type === 'image' && item.url ? (
          <img src={item.url} alt="" className="size-full object-cover" />
        ) : (
          <TypeIcon type={item.type} />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{item.filename ?? TYPE_LABEL[item.type]}</span>
        <span className="text-muted-foreground text-xs">
          {TYPE_LABEL[item.type]} · {formatSize(item.sizeBytes)}
        </span>
      </div>

      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label="Subir" onClick={onUp} disabled={disabled || first}>
          <ChevronUp size={14} aria-hidden />
        </IconButton>
        <IconButton label="Bajar" onClick={onDown} disabled={disabled || last}>
          <ChevronDown size={14} aria-hidden />
        </IconButton>
        <IconButton label="Quitar" onClick={onRemove} disabled={disabled}>
          <Trash2 size={14} aria-hidden />
        </IconButton>
      </div>
    </li>
  )
}

function TypeIcon({ type }: { type: ServiceMediaType }): React.JSX.Element {
  const className = 'text-muted-foreground'
  if (type === 'pdf') return <FileText className={className} size={18} aria-hidden />
  if (type === 'audio') return <FileAudio className={className} size={18} aria-hidden />
  if (type === 'video') return <FileVideo className={className} size={18} aria-hidden />
  return <ImageOff className={className} size={18} aria-hidden />
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string
  onClick: () => void
  disabled: boolean
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="text-muted-foreground hover:bg-emma-elevated hover:text-emma-text rounded p-1.5 disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
