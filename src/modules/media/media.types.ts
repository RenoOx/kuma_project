import type { MediaType } from './media.validate.js'

/** What a stored object is, which decides the key layout under the tenant prefix. */
export type MediaKind = 'service_media' | 'node_media' | 'payment_proof'

/** Which of the two owners a `service_media` row hangs from. */
export type MediaOwnerKind = 'service' | 'node'

/**
 * Where an upload should land.
 *
 * A discriminated union rather than a caller-supplied key: the key is built from
 * these ids by media.keys, so no caller — panel route or WhatsApp handler — can
 * hand in a path of its own choosing and write outside its tenant prefix.
 */
export type MediaTarget =
  | {
      kind: 'service_media'
      businessId: string
      serviceId: string
      /**
       * The id of the `service_media` row this file belongs to, minted BEFORE
       * the upload so the object and the row share it.
       *
       * That sharing is what makes cleanup provable rather than best-effort: a
       * row always knows its object, and an object under a service's folder
       * always names the row that should own it. Deriving one from the other
       * after the fact — by index, by timestamp — is how you end up with files
       * nobody can prove are unreferenced and nobody dares delete.
       */
      mediaId: string
    }
  | {
      /**
       * A file attached to a STEP of the conversation flow rather than to a
       * service — the material a business sends on entering a node, whatever
       * the customer asked about.
       */
      kind: 'node_media'
      businessId: string
      nodeId: string
      /** Same pre-minted row id as service_media, for the same reason. */
      mediaId: string
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
  type: MediaType
  bytes: number
}
