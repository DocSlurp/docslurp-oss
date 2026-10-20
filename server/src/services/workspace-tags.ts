import { sql } from "../db.js";

/** Call only after resolving and authorizing the workspace. Current versions include queued uploads. */
export async function listWorkspaceTags(workspaceId: string): Promise<Array<{ tag: string; documentCount: number }>> {
  const rows = await sql<{ tag: string; document_count: number }[]>`
    select t.tag, count(*)::int as document_count
    from document_tags t
    join documents d on d.id = t.document_id
    where d.workspace_id = ${workspaceId} and d.superseded_at is null
    group by t.tag
    order by t.tag
  `;
  return rows.map((row) => ({ tag: row.tag, documentCount: row.document_count }));
}
