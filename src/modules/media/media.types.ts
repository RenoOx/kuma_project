/** What a stored object is, which decides the key layout under the tenant prefix. */
export type MediaKind = 'service_image' | 'payment_proof'

/**
 * Where an upload should land.
 *
 * A discriminated union rather than a caller-supplied key: the key is built from
 * these ids by media.keys, so no caller — panel route or WhatsApp handler — can
 * hand in a path of its own choosing and write outside its tenant prefix.
 */
export type MediaTarget =
  | {
      kind: 'service_image'
      businessId: string
      serviceId: string
      /** 1-based slot. One image per service today; the slot keeps a gallery open. */
      index?: number
    }
  | {
      kind: 'payment_proof'
      businessId: string
      conversationId: string
      at?: Date
    }

export interface UploadedMedia {
  key: string
  mime: string
  bytes: number
}
