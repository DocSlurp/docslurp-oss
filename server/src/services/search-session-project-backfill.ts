import { sql as defaultSql } from "../db.js";

const BATCH = 5_000;
/** Batches per sweep (100,000 sessions a minute at the default interval); the next sweep continues. */
const MAX_BATCHES = 20;
const LOCK_KEY = "search-session-project-backfill";

type Sql = typeof defaultSql;

/**
 * Where this process's pass has reached among sessions without a project_id, in created_at order. Sessions whose
 * project is gone, or that never named one, stay null for good; the cursor steps over them once instead of
 * rereading them every sweep. Kept as text: a JS Date drops the microseconds.
 */
let cursor: string | null = null;
let finished = false;
let running = false;

/**
 * Fills search_sessions.project_id for sessions written before migration 0143, from metadata.projectId when that
 * project still exists. The migration only adds the column: updating every old row there held an exclusive lock on
 * a table every search writes to. Here each batch is its own short transaction, and one instance works at a time
 * (advisory lock), so the load on the database is one small UPDATE at a time.
 *
 * New sessions never need it (the insert sets the column, and the 0143 trigger covers writers that do not), so a
 * process stops for good after one pass. A restarted process makes one more pass, which reads only the sessions
 * that legitimately have no project, through search_sessions_project_id_created_at_idx.
 */
export async function sweepSearchSessionProjectBackfill(
  options: { sql?: Sql; batchSize?: number; maxBatches?: number } = {},
): Promise<number> {
  if (finished || running) return 0;
  const sql = options.sql ?? defaultSql;
  const batchSize = options.batchSize ?? BATCH;
  running = true;
  let filled = 0;
  try {
    for (let i = 0; i < (options.maxBatches ?? MAX_BATCHES); i += 1) {
      const batch = await sql.begin(async (tx) => {
        const [lock] = await tx<{ locked: boolean }[]>`select pg_try_advisory_xact_lock(hashtext(${LOCK_KEY})) as locked`;
        if (!lock?.locked) return null;
        // Ordered exactly as search_sessions_project_id_created_at_idx, so a page is one short index range scan.
        // WITH TIES keeps sessions sharing the last created_at in the same page: the cursor never splits them.
        const [row] = await tx<{ scanned: number; filled: number; last_created_at: string | null }[]>`
          with page as (
            select s.id, s.created_at, s.metadata ->> 'projectId' as wanted
            from search_sessions s
            where s.project_id is null and s.created_at > ${cursor ?? "-infinity"}::text::timestamptz
            order by s.project_id, s.created_at
            fetch first ${batchSize} rows with ties
          ), filled as (
            update search_sessions s set project_id = p.id
            from page join projects p on p.id = page.wanted
            where s.id = page.id and s.project_id is null
            returning 1
          )
          select (select count(*) from page)::int as scanned, (select count(*) from filled)::int as filled,
            (select max(created_at)::text from page) as last_created_at
        `;
        return row!;
      });
      // Another instance holds the lock: it is doing this work.
      if (!batch) break;
      filled += batch.filled;
      if (batch.last_created_at) cursor = batch.last_created_at;
      if (batch.scanned < batchSize) {
        finished = true;
        break;
      }
    }
  } finally {
    running = false;
  }
  if (filled > 0 || finished) {
    console.log(`[search-session-project-backfill] filled ${filled} sessions${finished ? "; nothing left" : ""}`);
  }
  return filled;
}

export function resetSearchSessionProjectBackfillForTests(): void {
  cursor = null;
  finished = false;
  running = false;
}
