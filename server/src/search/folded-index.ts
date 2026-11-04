import { sql } from "../db.js";

/**
 * The folded keyword leg (to_tsvector('simple', docslurp_fold_text(text)), migration 0121) is served by a GIN
 * expression index that `node scripts/folded-search-index.mjs` builds CONCURRENTLY, outside the migrator
 * (docs/rollout-expand-contract-0121-0125.md). Keyword search works before it exists and while it is being built: the leg then
 * evaluates the expression for the workspace's chunks, which is slow on a large workspace, so it gets a short
 * statement timeout of its own and contributes nothing when it is cut off.
 */
export const FOLDED_INDEX_NAME = "document_chunks_ts_folded_expr_idx";

const READY_TTL_MS = 5 * 60_000;
const MISSING_TTL_MS = 30_000;

let cached: { ready: boolean; checkedAt: number } | null = null;

/** Statement timeout for a folded leg while the index is not built (SEARCH_FOLDED_UNINDEXED_TIMEOUT_MS, default 2000). */
export function foldedUnindexedTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.SEARCH_FOLDED_UNINDEXED_TIMEOUT_MS);
  return env.SEARCH_FOLDED_UNINDEXED_TIMEOUT_MS?.trim() && Number.isFinite(parsed)
    ? Math.min(60_000, Math.max(100, Math.trunc(parsed)))
    : 2_000;
}

/** True when the folded expression index exists and is valid. Cached; a lookup failure counts as "not built". */
export async function foldedIndexReady(now: number = Date.now()): Promise<boolean> {
  if (cached && now - cached.checkedAt < (cached.ready ? READY_TTL_MS : MISSING_TTL_MS)) return cached.ready;
  let ready = false;
  try {
    const rows = await sql<{ ready: boolean }[]>`
      select exists (
        select 1 from pg_index i
        where i.indexrelid = to_regclass(${`public.${FOLDED_INDEX_NAME}`})
          and i.indisvalid and i.indisready
      ) as ready
    `;
    ready = rows[0]?.ready === true;
  } catch {
    ready = false;
  }
  cached = { ready, checkedAt: now };
  return ready;
}

/** Test hook: forget the cached lookup. */
export function resetFoldedIndexCache(): void {
  cached = null;
}
