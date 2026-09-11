import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { logger } from '@/config/logger.js'
import { db } from '@/db/client.js'
import { conversations, messages } from '@/db/schema/index.js'
import { HUMAN_TAKEOVER_TIMEOUT_MS } from '@/modules/panel/panel.service.js'

// Ages a conversation's inbox label as it goes quiet, and hands a forgotten
// takeover back to Emma. PANEL_SPEC US-05 and US-10.
//
// Every rule below is expressed as ONE conditional UPDATE. Reading the
// candidates and then writing them back would race the message handler, which
// is writing the same rows whenever a customer replies — and losing that race
// means marking a live conversation 'lost' a second after it came back to life.
// The WHERE clause is the lock.
//
// These sweep every tenant at once and take no businessId, which is the same
// shape sendReminders uses: a background sweep has no "current tenant" to scope
// to. The rule these queries must not break is the other one — no row is ever
// read for one business and written under another, and nothing here moves data
// across the business_id boundary.

const HOUR_MS = 60 * 60 * 1000

/** No reply for this long after Emma's last word → 'waiting'. */
export const WAITING_AFTER_MS = 2 * HOUR_MS

/** Still nothing this long after that → 'lost'. */
export const LOST_AFTER_MS = 24 * HOUR_MS

export interface TransitionRunResult {
  toWaiting: number
  toLost: number
  takeoversReturned: number
}

/**
 * Conversations whose last message is older than `olderThan` and came from
 * Emma, not the customer.
 *
 * The direction check is what separates "the customer is ignoring us" from "we
 * have not answered yet" — only the first is a cooling lead. A thread where the
 * customer spoke last and got no reply is a problem for the owner to see in the
 * inbox, not a lead to quietly age into 'lost'.
 */
function lastWordWasEmma(olderThan: Date) {
  return sql`(
    SELECT m.sender_type FROM ${messages} m
    WHERE m.conversation_id = ${conversations.id}
      AND m.role IN ('user', 'assistant')
      AND length(trim(m.content)) > 0
    ORDER BY m.created_at DESC
    LIMIT 1
  ) IN ('bot', 'human') AND ${conversations.lastMessageAt} < ${olderThan.toISOString()}::timestamptz`
}

export async function runQualificationTransitions(
  now: Date = new Date(),
): Promise<TransitionRunResult> {
  const waitingCutoff = new Date(now.getTime() - WAITING_AFTER_MS)
  const lostCutoff = new Date(now.getTime() - LOST_AFTER_MS)
  const takeoverCutoff = new Date(now.getTime() - HUMAN_TAKEOVER_TIMEOUT_MS)

  // 1. Cooling: a lead we spoke to last and who has not come back.
  //    'human_takeover' and 'appointment' are excluded by the IN clause, which
  //    is US-10 AC4 and AC5 — a human holds the first, and the second is a
  //    booking that a quiet week does not undo.
  const toWaiting = await db
    .update(conversations)
    .set({ qualification: 'waiting', updatedAt: now })
    .where(
      and(
        eq(conversations.type, 'customer'),
        inArray(conversations.qualification, ['new', 'qualified']),
        // A label the owner pinned by hand does not age out from under them.
        isNull(conversations.qualificationLockedAt),
        lastWordWasEmma(waitingCutoff),
      ),
    )
    .returning({ id: conversations.id })

  // 2. Cold: still nothing a day later.
  const toLost = await db
    .update(conversations)
    .set({ qualification: 'lost', updatedAt: now })
    .where(
      and(
        eq(conversations.type, 'customer'),
        eq(conversations.qualification, 'waiting'),
        isNull(conversations.qualificationLockedAt),
        lastWordWasEmma(lostCutoff),
      ),
    )
    .returning({ id: conversations.id })

  // 3. Forgotten takeover: the owner picked the thread up and walked away.
  //    Back to 'new' rather than to what it was before, for the reason
  //    panelService.returnToEmma gives — the old label describes a conversation
  //    a human has since changed.
  const returned = await db
    .update(conversations)
    .set({ humanTakeoverAt: null, qualification: 'new', updatedAt: now })
    .where(
      and(
        eq(conversations.qualification, 'human_takeover'),
        isNotNull(conversations.humanTakeoverAt),
        lt(conversations.humanTakeoverAt, takeoverCutoff),
      ),
    )
    .returning({ id: conversations.id })

  // Logged per row, not just as a count: when an owner asks why a conversation
  // went cold, this is the only record of the decision (US-05 AC4, US-10 AC6).
  for (const row of toWaiting) {
    logger.info({ conversationId: row.id, to: 'waiting' }, 'qualification aged')
  }
  for (const row of toLost) {
    logger.info({ conversationId: row.id, to: 'lost' }, 'qualification aged')
  }
  for (const row of returned) {
    logger.info({ conversationId: row.id }, 'human takeover timed out, returned to Emma')
  }

  return {
    toWaiting: toWaiting.length,
    toLost: toLost.length,
    takeoversReturned: returned.length,
  }
}

// Re-entry guard, same shape as sendReminders. A run that outlives its interval
// would otherwise get a second copy of itself competing for the same rows.
let running = false

export async function runQualificationTransitionsGuarded(): Promise<void> {
  if (running) {
    logger.warn('qualification transitions still running from a previous tick — skipping this one')
    return
  }
  running = true
  try {
    const result = await runQualificationTransitions()
    if (result.toWaiting + result.toLost + result.takeoversReturned > 0) {
      logger.info(result, 'qualification transitions run complete')
    }
  } finally {
    running = false
  }
}
