import { sql } from "../db.js";

export function workspaceSubject(value: string): string | null {
  const title = value.replace(/^#+\s*/, "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (title.length < 3 || /^(?:untitled|contents|table of contents|copyright|all rights reserved|page \d+)$/i.test(title)) return null;
  const words = title.split(" ").slice(0, 9).join(" ");
  return words.slice(0, 72).replace(/\s+\S*$/, words.length > 72 ? "" : "$&");
}

export function workspaceChatSubject(message: string): string | null {
  return workspaceSubject(message.trim().replace(/^(?:please\s+)?(?:can you|could you|help me|i want to|i need to)\s+/i, "").replace(/[?!]+$/, ""));
}

export async function markWorkspaceAutoNamed(workspaceId: string, userId: string, name: string) {
  await sql`
    insert into workspace_search_settings (workspace_id, user_id, compat_metadata)
    values (${workspaceId}, ${userId}, jsonb_build_object('autoTitle', jsonb_build_object('phase', 'upload', 'name', ${name}::text)))
    on conflict (workspace_id) do update set compat_metadata = workspace_search_settings.compat_metadata || excluded.compat_metadata
  `;
}

/** Only upload-created titles are replaced. A manual edit stops automatic naming. */
export async function refineWorkspaceNames(workspaceIds: string[], firstMessage?: string) {
  if (!workspaceIds.length) return;
  const rows = await sql<{ id: string; name: string; title: string | null }[]>`
    select w.id, w.name, coalesce(c.metadata ->> 'title', c.heading_path[1]) as title
    from workspaces w
    join workspace_search_settings s on s.workspace_id = w.id
    left join lateral (
      select dc.metadata, dc.heading_path from document_chunks dc
      join documents d on d.id = dc.document_id
      where d.workspace_id = w.id and (dc.metadata ->> 'title' is not null or array_length(dc.heading_path, 1) > 0)
      order by d.created_at, dc.chunk_index limit 1
    ) c on true
    where w.id = any(${workspaceIds}) and s.compat_metadata -> 'autoTitle' ->> 'name' = w.name
      and s.compat_metadata -> 'autoTitle' ->> 'phase' = any(${firstMessage ? ["upload", "content"] : ["upload"]})
  `;
  for (const row of rows) {
    const name = firstMessage ? workspaceChatSubject(firstMessage) : workspaceSubject(row.title ?? "");
    if (!name) continue;
    await sql`
      with renamed as (
        update workspaces set name = ${name}, updated_at = now() where id = ${row.id} and name = ${row.name} returning id
      )
      update workspace_search_settings set compat_metadata = jsonb_set(compat_metadata, '{autoTitle}', jsonb_build_object('phase', ${firstMessage ? "chat" : "content"}::text, 'name', ${name}::text))
      where workspace_id in (select id from renamed)
    `;
  }
}
