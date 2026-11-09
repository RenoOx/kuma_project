import type { MessageAttachment } from '@/db/schema/index.js'

// Lo que se guarda en `messages.attachments` a partir de lo que salió por
// WhatsApp. Solo la key y el tipo: el panel firma el link al leer.

const TYPE_BY_EXT: Record<string, MessageAttachment['type']> = {
  jpg: 'image',
  png: 'image',
  webp: 'image',
  pdf: 'pdf',
  wav: 'audio',
  ogg: 'audio',
  mp3: 'audio',
  mp4: 'video',
}

/**
 * El tipo por la extensión de la key. Las keys las arma media.keys con la
 * extensión que detectó media.validate por los bytes, nunca con la que dijo
 * quien subió: leerla de vuelta es leer esa misma detección.
 */
export function attachmentTypeOfKey(s3Key: string): MessageAttachment['type'] {
  const ext = s3Key.slice(s3Key.lastIndexOf('.') + 1).toLowerCase()
  return TYPE_BY_EXT[ext] ?? 'image'
}

/** La galería de un mensaje fijo (solo keys) como adjuntos del mensaje. */
export function galleryAttachments(keys: readonly string[] | undefined): MessageAttachment[] {
  return (keys ?? []).map((s3Key) => ({ s3Key, type: attachmentTypeOfKey(s3Key) }))
}
