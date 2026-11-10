import { readPageImageReadiness } from "../services/page-image-readiness.js";
import { realtimeSuggestionsSnapshotSchema } from "@docslurp/shared";
import { readProjectSuggestions } from "../services/project-suggestions.js";
import type { RealtimeBackend, DashboardResource } from "./broker.js";
import { sql } from "../db.js";
import { isConfiguredAdminUserSql } from "../lib/admin-emails.js";
import { projectUsageTotals, runUsageCostSummaries } from "../services/usage-attribution.js";
import { getBillingOverview } from "../services/billing/overview.js";
import { getProject } from "../services/projects.js";
import { listDocumentIndexEntries, getRealtimeViewerPayload } from "../services/documents.js";
import { mapProjectRun, type ProjectRunRow } from "../services/run-records.js";
import { buildRunProgressSnapshot } from "../services/runs.js";

/** One statement and one MVCC boundary for a socket's bounded resource sweep.
 * This matches getProjectAccess, including explicitly shared personal projects.
 * It is session-only; API key allowlists never enter this adapter.
 */
async function authorizeMany(userId: string, resources: DashboardResource[]): Promise<Array<string | null>> {
  if (resources.length > 32) throw new Error("subscription_limit");
  if (!resources.length) return [];
  const inputs = resources.map((r, index) => ({ ...r, index }));
  const rows = await sql<{ index: number; org_id: string | null }[]>`
    with requested as (
      select * from jsonb_to_recordset(${sql.json(inputs)})
        as x(index int, kind text, "orgId" text, "projectId" text, "runId" text, "documentId" text)
    )
    select x.index,
      case when x.kind in ('activity','billing','economics') then
        case when om.user_id is not null and
          (x.kind='activity' or om.role in ('owner','admin')) then o.id end
      else case when w.id is not null and docslurp_project_access(w.id,${userId})
        then w.org_id end end as org_id
    from requested x
    left join project_runs r on x.kind='run' and r.id=x."runId"
    left join documents d on x.kind in ('viewer','page-image') and d.id=x."documentId"
      and (x.kind<>'page-image' or d.run_id=x."runId")
    left join projects w on w.id=case when x.kind='run' then r.project_id
      when x.kind in ('viewer','page-image') then d.project_id else x."projectId" end
    left join organizations o on o.id=case when x.kind in ('activity','billing','economics')
      then x."orgId" else w.org_id end
    left join org_memberships om on om.org_id=o.id and om.user_id=${userId}
    order by x.index`;
  if (rows.length !== resources.length) throw new Error("authorization_incomplete");
  return rows.map(row => row.org_id);
}
async function authorize(userId: string, resource: DashboardResource): Promise<string | null> {
  return (await authorizeMany(userId, [resource]))[0] ?? null;
}

export const realtimeBackend: RealtimeBackend = {
  authorize,
  authorizeMany,
  async authorizeDelivery(userId, resource, data) {
    if (resource.kind !== "activity") return !!await authorize(userId, resource);
    if (!data || typeof data !== "object" || !("runs" in data) || !Array.isArray(data.runs)) return false;
    const ids = new Set<string>();
    for (const run of data.runs) {
      if (!run || typeof run !== "object" || typeof run.projectId !== "string") return false;
      ids.add(run.projectId);
    }
    if (ids.size > 200) return false;
    const visible = await sql<{ id: string }[]>`select w.id from projects w
      where w.org_id=${resource.orgId} and w.id=any(${sql.array([...ids])})
        and docslurp_project_access(w.id,${userId})`;
    return visible.length === ids.size && !!await authorize(userId, resource);
  },
  async revisions(orgIds) {
    const rows = await sql<{ org_id: string; revision: string }[]>`select org_id, revision::text from realtime_revisions where org_id = any(${sql.array(orgIds)})`;
    return new Map(rows.map(row => [row.org_id, row.revision]));
  },
  async listen(wake) {
    const subscription = await sql.listen("realtime_changed", wake);
    return () => subscription.unlisten();
  },
  async project(userId, resource) {
    const orgId = await authorize(userId, resource);
    if (!orgId) throw new Error("forbidden");
    switch (resource.kind) {
      case "billing": return await getBillingOverview(orgId);
      case "run": {
        const [row] = await sql<ProjectRunRow[]>`select r.*, w.name as project_name
          from project_runs r join projects w on w.id = r.project_id
          where r.id = ${resource.runId} and r.org_id = ${orgId}`;
        if (!row) throw new Error("not_found");
        return await buildRunProgressSnapshot(mapProjectRun(row), { recentEventLimit: 100, readOnly: true, operator: await isConfiguredAdminUserSql(sql, userId) });
      }
      case "activity": {
        const runs = await sql<ProjectRunRow[]>`
          select r.*, w.name as project_name
          from project_runs r join projects w on w.id = r.project_id
          where r.org_id = ${orgId} and docslurp_project_access(w.id, ${userId})
          order by (r.status in ('queued','processing')) desc, r.updated_at desc, r.id limit 201`;
        const costs = await runUsageCostSummaries(runs.slice(0, 200).map(run => run.id));
        return { runs: runs.slice(0, 200).map(run => mapProjectRun(run, costs.get(run.id))), truncated: runs.length > 200 };
      }
      case "suggestions": return realtimeSuggestionsSnapshotSchema.parse(await readProjectSuggestions(userId, resource.projectId, { limit: 8 }));
      case "page-image": return await readPageImageReadiness(userId, resource);
      case "viewer": {
        const viewer = await getRealtimeViewerPayload(resource.documentId, userId);
        if (!viewer) throw new Error("not_found");
        return viewer;
      }
      case "project": return await getProject(resource.projectId, userId, { refineNames: false });
      case "documents": return await listDocumentIndexEntries({ userId, orgId,
        projectId: resource.projectId, limit: 50, offset: resource.page * 50 });
      case "economics": {
        const rows = await sql<{ projectId: string; name: string; documentCount: number; pageCount: number; sourceBytes: number; activeRuns: number; pagesProcessed: number; runtimeMs: number }[]>`
          select w.id as "projectId", w.name,
            (select count(*)::int from documents d where d.project_id=w.id and d.superseded_at is null) as "documentCount",
            (select coalesce(sum(page_count),0)::float8 from documents d where d.project_id=w.id and d.superseded_at is null) as "pageCount",
            (select coalesce(sum(file_size),0)::float8 from documents d where d.project_id=w.id and d.superseded_at is null) as "sourceBytes",
            (select count(*)::int from project_runs r where r.project_id=w.id and r.status in ('queued','processing')) as "activeRuns",
            (select coalesce(sum(pages_processed),0)::float8 from project_runs r where r.project_id=w.id and r.status='completed') as "pagesProcessed",
            (select coalesce(sum(greatest(0,extract(epoch from(updated_at-created_at))*1000)),0)::float8 from project_runs r where r.project_id=w.id and r.status='completed') as "runtimeMs"
          from projects w where w.org_id=${orgId} order by w.id limit 51 offset ${resource.page * 50}`;
        const projects = [];
        // Bound concurrent aggregate reads even for a large organization's board.
        for (let i=0; i<Math.min(rows.length,50); i+=5) {
          projects.push(...await Promise.all(rows.slice(i,Math.min(i+5,50)).map(async row =>
            ({ ...row, usage: await projectUsageTotals(row.projectId, null) }))));
        }
        return { projects, page: resource.page, hasMore: rows.length > 50 };
      }
    }
  },
};
