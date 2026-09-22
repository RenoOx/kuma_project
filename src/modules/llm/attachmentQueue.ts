import type { ToolAttachment } from './toolExecutor.js'

// The files one reply will carry, collected across every tool call the turn made.
//
// Pure and on its own so it can be tested without a database: the turn loop it
// serves lives inside generateReply, which needs OpenAI and four repositories to
// run at all.

/**
 * How many files one turn may send, however many services it touched.
 *
 * Every attachment is its own outbound WhatsApp message, and a rate-limited
 * number takes the whole business offline rather than just the photos — this
 * project has already lived through that once, on 2026-07-01.
 *
 * It used to be applied inside the tool executor, on one service's file list.
 * That bounds a service, not a turn: the model may call send_service_media once
 * per service in the same turn, so three services with two files each produced
 * six sends under a constant named PER_TURN. Harmless while sending was the
 * model's choice; not harmless now that it is an obligation.
 *
 * The number itself is about LATENCY, not about bans. sendQueue already caps a
 * business at 25 sends a minute and 200 an hour with a 1–2.5s gap, and that is
 * what protects the number. What this protects is the shared lane: every extra
 * attachment is a couple of seconds another customer's reply spends waiting.
 * That is why the catalogue path may raise it (see MAX_SERVICE_CARDS_PER_TURN)
 * and nothing else may.
 */
export const MAX_ATTACHMENTS_PER_TURN = 2

/**
 * Adds a tool's attachments to the turn's queue, deduplicated and capped.
 *
 * Mutates `queued`, which is the turn's accumulator — the caller folds over it
 * across loop iterations and there is nothing to gain from rebuilding it.
 *
 * Deduplicated by S3 key because the send registry is only written once the
 * handler has actually sent: a model that asks for the same photo twice across
 * two iterations would otherwise queue it twice, and the customer would get it
 * twice in one reply.
 *
 * `max` is a parameter and not the constant so the catalogue can send one card
 * per service — a card is an image WITH its caption, so it is one message and
 * not two, and a listing of four is what the feature is for. It defaults to the
 * constant: every other caller keeps the old ceiling without knowing it moved.
 */
export function queueAttachments(
  queued: ToolAttachment[],
  incoming: readonly ToolAttachment[],
  max: number = MAX_ATTACHMENTS_PER_TURN,
): void {
  for (const attachment of incoming) {
    if (queued.length >= max) return
    if (!queued.some((already) => already.s3Key === attachment.s3Key)) {
      queued.push(attachment)
    }
  }
}
