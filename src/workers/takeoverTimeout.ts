import { and, isNotNull, lt } from 'drizzle-orm'
import { logger } from '@/config/logger.js'
import { db } from '@/db/client.js'
import { conversations } from '@/db/schema/index.js'
import { HUMAN_TAKEOVER_TIMEOUT_MS } from '@/modules/panel/panel.service.js'

// Hands a forgotten takeover back to Emma. PANEL_SPEC US-05.
//
// This file used to also age quiet leads into 'waiting' and 'lost'. That went
// away with the qualification enum: labelling a conversation is the owner's job
// now, and a worker deciding on its own that a lead is lost is exactly the kind
// of automatic verdict the owner-authored tags replaced.
//
// Expressed as ONE conditional UPDATE. Reading the candidates and then writing
// them back would race the message handler, which is writing the same rows
// whenever a customer replies. The WHERE clause is the lock.
//
// Sweeps every tenant at once and takes no businessId, the same shape
// sendReminders uses: a background sweep has no "current tenant" to scope to.
// The rule it must not break is the other one — no row is read for one business
// and written under another.

export interface TakeoverRunResult {
  takeoversReturned: number
}

export async function runTakeoverTimeout(now: Date = new Date()): Promise<TakeoverRunResult> {
  const cutoff = new Date(now.getTime() - HUMAN_TAKEOVER_TIMEOUT_MS)

  // Clears the clock and nothing else. In particular it does NOT touch
  // `emmaEnabled`: a thread where the owner switched Emma off by hand must not
  // come back to life because a takeover expired. Those are two decisions and
  // only one of them has a timer.
  const returned = await db
    .update(conversations)
    .set({ humanTakeoverAt: null, updatedAt: now })
    .where(and(isNotNull(conversations.humanTakeoverAt), lt(conversations.humanTakeoverAt, cutoff)))
    .returning({ id: conversations.id })

  // Logged per row, not just as a count: when an owner asks why Emma started
  // answering a thread they were holding, this is the only record (US-05 AC4).
  for (const row of returned) {
    logger.info({ conversationId: row.id }, 'human takeover timed out, returned to Emma')
  }

  return { takeoversReturned: returned.length }
}

// Re-entry guard, same shape as sendReminders. A run that outlives its interval
// would otherwise get a second copy of itself competing for the same rows.
let running = false

export async function runTakeoverTimeoutGuarded(): Promise<void> {
  if (running) {
    logger.warn('takeover timeout still running from a previous tick — skipping this one')
    return
  }
  running = true
  try {
    const result = await runTakeoverTimeout()
    if (result.takeoversReturned > 0) {
      logger.info(result, 'takeover timeout run complete')
    }
  } finally {
    running = false
  }
}
