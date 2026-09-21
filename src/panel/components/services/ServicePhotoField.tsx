import { ImageOff, Trash2, Upload } from 'lucide-react'
import { useRef } from 'react'
import { useServiceImage } from '../../hooks/useServiceImage.js'
import { useSettings } from '../../hooks/useSettings.js'
import { Button } from '../ui/button.js'
import { Label } from '../ui/label.js'

const ACCEPT = 'image/jpeg,image/png,image/webp'

/**
 * The service's photo.
 *
 * Unlike every other field in this dialog, this one writes immediately: the file
 * goes to storage and its key onto the service the moment it is picked, rather
 * than waiting for Guardar. Holding a 5MB file in memory until an unrelated save
 * would be worse, and the copy says which of the two is happening.
 *
 * Disabled with a reason in the two cases where an upload cannot work at all: a
 * service that was never saved has no id for the key to be built from, and a
 * deploy with no S3 credentials has nowhere to put the file. Both are explained
 * rather than silently greyed out.
 */
export function ServicePhotoField({
  serviceId,
}: {
  /** Undefined while the service is being created — it has no id yet. */
  serviceId: string | undefined
}): React.JSX.Element {
  const settings = useSettings()
  const image = useServiceImage(serviceId)
  const input = useRef<HTMLInputElement>(null)

  const mediaConfigured = settings.data?.mediaConfigured ?? false
  const unsaved = serviceId === undefined
  const blocked = unsaved || !mediaConfigured
  const disabled = blocked || image.busy

  const hint = unsaved
    ? 'Guardá el servicio primero y volvé a abrirlo para subirle una foto.'
    : !mediaConfigured
      ? 'El almacenamiento de fotos todavía no está configurado. Escribinos a Vamvu Labs.'
      : 'Emma la manda cuando el cliente pide ver ejemplos. Se guarda al instante, sin esperar a Guardar. JPG, PNG o WEBP, hasta 5MB.'

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="svc-photo">Foto del servicio</Label>

      <div className="flex items-center gap-3">
        <div className="bg-muted flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border">
          {image.url ? (
            // Sized rather than object-fit-free so a portrait and a landscape
            // photo both read as the same tile in the dialog.
            <img src={image.url} alt="" className="size-full object-cover" />
          ) : (
            <ImageOff className="text-muted-foreground" size={18} aria-hidden />
          )}
        </div>

        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled}
              onClick={() => input.current?.click()}
            >
              <Upload size={14} aria-hidden />
              {image.hasImage ? 'Cambiar foto' : 'Subir foto'}
            </Button>

            {image.hasImage && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => image.remove()}
              >
                <Trash2 size={14} aria-hidden />
                Quitar
              </Button>
            )}
          </div>

          <span className="text-muted-foreground text-xs">
            {image.busy ? 'Guardando la foto…' : hint}
          </span>
        </div>
      </div>

      <input
        ref={input}
        id="svc-photo"
        type="file"
        accept={ACCEPT}
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) image.upload(file)
          // Cleared so picking the same file again still fires a change event —
          // which is exactly what a retry after a failed upload looks like.
          e.target.value = ''
        }}
      />

      {image.error && <p className="text-destructive text-sm">{image.error}</p>}
    </div>
  )
}
