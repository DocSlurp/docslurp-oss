import { sql } from "../db.js";
import type { ChatProjectInventory } from "./chat-mcp-agent.js";

/**
 * Grounded corpus counts for the agent prompt, each read from a project
 * index. The failed count (current versions only: a failed upload later
 * replaced or archived is not a problem) is a suggestions-mode signal, so it
 * runs only in that mode.
 */
export async function loadChatProjectInventory(projectId: string, includeFailed: boolean): Promise<ChatProjectInventory> {
  const [counts] = await sql<{ searchable: number; processing: number; failed: number }[]>`
    select coalesce((select document_count from project_corpus_stats where project_id = ${projectId}), 0)::int as searchable,
      (select count(*)::int from documents where project_id = ${projectId}
        and status not in ('completed', 'failed', 'cancelled', 'pii_blocked')) as processing,
      ${includeFailed ? sql`(select count(*)::int from documents where project_id = ${projectId} and status = 'failed'
        and superseded_at is null and archived_at is null and purged_at is null)` : sql`0`} as failed
  `;
  return { searchableDocuments: counts?.searchable ?? 0, processingDocuments: counts?.processing ?? 0, failedDocuments: counts?.failed ?? 0 };
}
