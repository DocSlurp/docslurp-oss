import { sql } from "../db.js";
import type { ChatWorkspaceInventory } from "./chat-mcp-agent.js";

/**
 * Grounded corpus counts for the agent prompt, each read from a workspace
 * index. The failed count (current versions only: a failed upload later
 * replaced or archived is not a problem) is a suggestions-mode signal, so it
 * runs only in that mode.
 */
export async function loadChatWorkspaceInventory(workspaceId: string, includeFailed: boolean): Promise<ChatWorkspaceInventory> {
  const [counts] = await sql<{ searchable: number; processing: number; failed: number }[]>`
    select coalesce((select document_count from workspace_corpus_stats where workspace_id = ${workspaceId}), 0)::int as searchable,
      (select count(*)::int from documents where workspace_id = ${workspaceId}
        and status not in ('completed', 'failed', 'cancelled', 'pii_blocked')) as processing,
      ${includeFailed ? sql`(select count(*)::int from documents where workspace_id = ${workspaceId} and status = 'failed'
        and superseded_at is null and archived_at is null and purged_at is null)` : sql`0`} as failed
  `;
  return { searchableDocuments: counts?.searchable ?? 0, processingDocuments: counts?.processing ?? 0, failedDocuments: counts?.failed ?? 0 };
}
