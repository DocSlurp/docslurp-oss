import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { SummaryTreeStateRefused, type SummaryTreeScope } from "./state-store.js";

/** Publish only a complete tree's root, in the caller's fenced finalization transaction.
 * The earlier sampled artifact remains a historical stage artifact; document readers use this row.
 * Updating every existing row also handles summaries copied by a partial reprocess.
 */
export async function publishSummaryTreeRoot(sql: Sql<Record<string, unknown>>, input: {
  scope: SummaryTreeScope; documentId: string; runId: string; owner: string;
  summary: { title: string; text: string };
}): Promise<void> {
  const text = `${input.summary.title}\n\n${input.summary.text}`.trim();
  if (!text) throw new SummaryTreeStateRefused("A summary tree root must not be empty");
  const rows = await sql`
    with eligible as (
      select d.id, d.user_id from documents d
      join document_summary_trees t on t.document_id = d.id and t.org_id = d.org_id and t.project_id = d.project_id
      where d.id = ${input.documentId} and d.org_id = ${input.scope.orgId} and d.project_id = ${input.scope.projectId}
        and d.run_id = ${input.runId} and d.purged_at is null and d.archived_at is null and d.superseded_at is null
        and t.status = 'building' and t.build_owner = ${input.owner} and t.skip_reason is distinct from 'corrected'
    ), replaced as (
      update document_summaries s set summary = ${text}
      from eligible d where s.document_id = d.id and s.run_id = ${input.runId}
      returning s.id
    ), inserted as (
      insert into document_summaries (id, document_id, run_id, user_id, summary)
      select ${randomUUID()}, d.id, ${input.runId}, d.user_id, ${text} from eligible d
      where not exists (select 1 from replaced)
      returning id
    )
    select id from replaced union all select id from inserted
  `;
  if (!rows.length) throw new SummaryTreeStateRefused("The document no longer belongs to this tree builder");
}
