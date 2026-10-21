import type { SqlClient } from "../db.js";

/**
 * NOTIFY channel for eligibility changes the worker's `run_events` hints do
 * not cover: API-side document deletion. Native search (eligible-documents.ts)
 * listens and drops the named workspaces' cached eligible sets, so a deleted
 * document stops being served by every API process as soon as the delete
 * commits instead of after SEARCH_ELIGIBLE_CACHE_TTL_MS. Payload:
 * `{"workspaceIds":[...]}`. Kept free of search imports so services can emit it.
 */
export const SEARCH_ELIGIBILITY_CHANNEL = "search_eligibility";

/** Queue the hint on `client`; inside a transaction it is delivered when the transaction commits. */
export async function notifySearchEligibilityChanged(client: SqlClient, workspaceIds: readonly string[]): Promise<void> {
  const ids = [...new Set(workspaceIds.filter(Boolean))];
  if (ids.length === 0) return;
  // Stay far below PostgreSQL's 8,000-byte NOTIFY payload limit.
  for (let offset = 0; offset < ids.length; offset += 100) {
    await client`select pg_notify(${SEARCH_ELIGIBILITY_CHANNEL}, ${JSON.stringify({ workspaceIds: ids.slice(offset, offset + 100) })})`;
  }
}
