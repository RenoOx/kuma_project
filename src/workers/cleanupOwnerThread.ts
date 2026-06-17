import { logger } from '@/config/logger.js'
import { db } from '@/db/client.js'
import { sql } from 'drizzle-orm'

const RETENTION_HOURS = 48

// Deletes messages older than RETENTION_HOURS in any owner_thread
// conversation. The owner_thread row itself is left intact so the rolling
// thread keeps its identity across cleanup runs.
//
// TODO Día 11: migrar a BullMQ scheduled job cuando deployemos a Railway.
export async function cleanupOwnerThreadMessages(): Promise<number> {
  // We use a raw DELETE here because Drizzle's typed delete doesn't compose
  // well with an IN(SELECT ...) subquery for the cross-table filter we need.
  // The query is safe because none of the inputs come from outside the
  // process — RETENTION_HOURS is a constant defined above.
  const result = await db.execute(sql.raw(`
    DELETE FROM messages
    WHERE conversation_id IN (
      SELECT id FROM conversations WHERE type = 'owner_thread'
    )
    AND created_at < NOW() - INTERVAL '${RETENTION_HOURS} hours'
  `))
  // postgres-js exposes the affected row count on the underlying result.
  const count = (result as unknown as { count?: number }).count ?? 0
  if (count > 0) {
    logger.info(
      { rowsDeleted: count, retentionHours: RETENTION_HOURS },
      'owner_thread cleanup deleted aged messages',
    )
  }
  return count
}
