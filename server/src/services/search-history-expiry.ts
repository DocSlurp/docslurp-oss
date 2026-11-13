import { sql } from "../db.js";

const BATCH = 2_000;
/** Batches per sweep, so one sweep never holds the database for long; the next sweep continues. */
const MAX_BATCHES = 25;

/**
 * Deletes search sessions past expires_at (API-key keyword and hybrid searches, lean-logging.ts) in small batches.
 * search_session_results and search_zero_results cascade; chat evidence spans keep their row with a null session.
 * Safe on every instance at once: SKIP LOCKED leaves rows another sweep is deleting.
 */
export async function sweepExpiredSearchSessions(): Promise<number> {
  let deleted = 0;
  for (let i = 0; i < MAX_BATCHES; i += 1) {
    const rows = await sql<{ id: string }[]>`
      delete from search_sessions
      where id in (
        select id from search_sessions
        where expires_at is not null and expires_at < now()
        order by expires_at
        limit ${BATCH}
        for update skip locked
      )
      returning id
    `;
    deleted += rows.length;
    if (rows.length < BATCH) break;
  }
  if (deleted > 0) console.log(`[search-history-expiry] deleted ${deleted} expired search sessions`);
  return deleted;
}
