import type { Sql } from "postgres";

type Client = Sql<Record<string, unknown>>;

/**
 * Next version number in a document's chain, allocated under the same per-(workspace, canonical id)
 * advisory lock uploads take, so a re-index or reprocess never reuses the number of an upload that is
 * still in flight. The lock is held until the surrounding transaction ends; call it inside `sql.begin`.
 */
export async function nextVersionNumber(tx: Client, workspaceId: string, canonicalId: string): Promise<number> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${canonicalId}`}, 0))`;
  const [row] = await tx<{ latest: number | null }[]>`
    select max(version_number)::int as latest from documents
    where workspace_id = ${workspaceId} and canonical_id = ${canonicalId}
  `;
  return (row?.latest ?? 0) + 1;
}
