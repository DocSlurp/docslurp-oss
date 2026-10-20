import { documentTagPredicate } from "./document-tags.js";
import { sql } from "../db.js";

export async function expandGraphTextQuery(args: {
  enabled: boolean | undefined;
  query: string;
  textQuery: string;
  workspaceId: string;
  tags?: string[];
}): Promise<string> {
  if (!args.enabled) {
    return args.textQuery;
  }

  try {
    const entityRows = await sql<
      { entity_name: string; mention_count: number }[]
    >`
      select ce.entity_name, sum(ce.mention_count)::int as mention_count
      from chunk_entities ce
      join document_chunks c on c.id = ce.chunk_id
      join documents d on d.id = c.document_id
      where d.workspace_id = ${args.workspaceId}
        and d.superseded_at is null
        and ${documentTagPredicate(sql`d.id`, args.tags)}
        and d.status <> 'pii_blocked'
        and (
          c.ts_content @@ websearch_to_tsquery('english', ${args.query})
          or lower(ce.entity_name) = any(
            select lower(unnest(string_to_array(${args.query}, ' ')))
          )
        )
      group by ce.entity_name
      order by mention_count desc
      limit 8
    `;
    const entityTerms = entityRows
      .map((row) => row.entity_name)
      .filter(
        (name) => !args.textQuery.toLowerCase().includes(name.toLowerCase()),
      )
      .slice(0, 4)
      .join(" ");

    return entityTerms ? `${args.textQuery} ${entityTerms}` : args.textQuery;
  } catch {
    return args.textQuery;
  }
}
