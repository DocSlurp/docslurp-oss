import { realtimeSuggestionsSnapshotSchema } from "@docslurp/shared";
import { readWorkspaceSuggestions } from "../services/workspace-suggestions.js";
import type { RealtimeBackend, DashboardResource } from "./broker.js";
import { sql } from "../db.js";
import { workspaceUsageTotals, runUsageCostSummaries } from "../services/usage-attribution.js";
import { getBillingOverview } from "../services/billing/overview.js";
import { getWorkspace } from "../services/workspaces.js";
import { listDocumentIndexEntries, getRealtimeViewerPayload } from "../services/documents.js";
import { mapWorkspaceRun, type WorkspaceRunRow } from "../services/run-records.js";
import { buildRunProgressSnapshot } from "../services/runs.js";

/** One statement and one MVCC boundary for a socket's bounded resource sweep.
 * This matches getWorkspaceAccess, including explicitly shared personal workspaces.
 * It is session-only; API key allowlists never enter this adapter.
 */
async function authorizeMany(userId: string, resources: DashboardResource[]): Promise<Array<string | null>> {
  if (resources.length > 32) throw new Error("subscription_limit");
  if (!resources.length) return [];
  const inputs = resources.map((r, index) => ({ ...r, index }));
  const rows = await sql<{ index: number; org_id: string | null }[]>`
    with requested as (
      select * from jsonb_to_recordset(${sql.json(inputs)})
        as x(index int, kind text, "orgId" text, "workspaceId" text, "runId" text, "documentId" text)
    )
    select x.index,
      case when x.kind in ('activity','billing','economics') then
        case when om.user_id is not null and
          (x.kind='activity' or om.role in ('owner','admin')) then o.id end
      else case when w.id is not null and (
        (om.user_id is not null and (w.user_id=${userId} or wm.user_id is not null
          or om.role in ('owner','admin') or w.is_default))
        or (wm.user_id is not null and o.is_personal)
      ) then w.org_id end end as org_id
    from requested x
    left join workspace_runs r on x.kind='run' and r.id=x."runId"
    left join documents d on x.kind='viewer' and d.id=x."documentId"
    left join workspaces w on w.id=case when x.kind='run' then r.workspace_id
      when x.kind='viewer' then d.workspace_id else x."workspaceId" end
    left join organizations o on o.id=case when x.kind in ('activity','billing','economics')
      then x."orgId" else w.org_id end
    left join org_memberships om on om.org_id=o.id and om.user_id=${userId}
    left join workspace_members wm on wm.workspace_id=w.id and wm.user_id=${userId}
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
      if (!run || typeof run !== "object" || typeof run.workspaceId !== "string") return false;
      ids.add(run.workspaceId);
    }
    if (ids.size > 200) return false;
    const visible = await sql<{ id: string }[]>`select w.id from workspaces w
      join org_memberships om on om.org_id=w.org_id and om.user_id=${userId}
      where w.org_id=${resource.orgId} and w.id=any(${sql.array([...ids])})
        and (w.user_id=${userId} or w.is_default or om.role in ('owner','admin')
          or exists(select 1 from workspace_members wm where wm.workspace_id=w.id and wm.user_id=${userId}))`;
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
        const [row] = await sql<WorkspaceRunRow[]>`select r.*, w.name as workspace_name
          from workspace_runs r join workspaces w on w.id = r.workspace_id
          where r.id = ${resource.runId} and r.org_id = ${orgId}`;
        if (!row) throw new Error("not_found");
        return await buildRunProgressSnapshot(mapWorkspaceRun(row), { recentEventLimit: 100, readOnly: true });
      }
      case "activity": {
        const runs = await sql<WorkspaceRunRow[]>`
          select r.*, w.name as workspace_name
          from workspace_runs r join workspaces w on w.id = r.workspace_id
          join org_memberships om on om.org_id = w.org_id and om.user_id = ${userId}
          where r.org_id = ${orgId} and (w.user_id = ${userId} or w.is_default or om.role in ('owner','admin')
            or exists (select 1 from workspace_members wm where wm.workspace_id = w.id and wm.user_id = ${userId}))
          order by (r.status in ('queued','processing')) desc, r.updated_at desc, r.id limit 201`;
        const costs = await runUsageCostSummaries(runs.slice(0, 200).map(run => run.id));
        return { runs: runs.slice(0, 200).map(run => mapWorkspaceRun(run, costs.get(run.id))), truncated: runs.length > 200 };
      }
      case "suggestions": return realtimeSuggestionsSnapshotSchema.parse(await readWorkspaceSuggestions(userId, resource.workspaceId, { limit: 8 }));
      case "viewer": {
        const viewer = await getRealtimeViewerPayload(resource.documentId, userId);
        if (!viewer) throw new Error("not_found");
        return viewer;
      }
      case "workspace": return await getWorkspace(resource.workspaceId, userId, { refineNames: false });
      case "documents": return await listDocumentIndexEntries({ userId, orgId,
        workspaceId: resource.workspaceId, limit: 50, offset: resource.page * 50 });
      case "economics": {
        const rows = await sql<{ workspaceId: string; name: string; documentCount: number; pageCount: number; sourceBytes: number; activeRuns: number; pagesProcessed: number; runtimeMs: number }[]>`
          select w.id as "workspaceId", w.name,
            (select count(*)::int from documents d where d.workspace_id=w.id and d.superseded_at is null) as "documentCount",
            (select coalesce(sum(page_count),0)::float8 from documents d where d.workspace_id=w.id and d.superseded_at is null) as "pageCount",
            (select coalesce(sum(file_size),0)::float8 from documents d where d.workspace_id=w.id and d.superseded_at is null) as "sourceBytes",
            (select count(*)::int from workspace_runs r where r.workspace_id=w.id and r.status in ('queued','processing')) as "activeRuns",
            (select coalesce(sum(pages_processed),0)::float8 from workspace_runs r where r.workspace_id=w.id and r.status='completed') as "pagesProcessed",
            (select coalesce(sum(greatest(0,extract(epoch from(updated_at-created_at))*1000)),0)::float8 from workspace_runs r where r.workspace_id=w.id and r.status='completed') as "runtimeMs"
          from workspaces w where w.org_id=${orgId} order by w.id limit 51 offset ${resource.page * 50}`;
        const workspaces = [];
        // Bound concurrent aggregate reads even for a large organization's board.
        for (let i=0; i<Math.min(rows.length,50); i+=5) {
          workspaces.push(...await Promise.all(rows.slice(i,Math.min(i+5,50)).map(async row =>
            ({ ...row, usage: await workspaceUsageTotals(row.workspaceId, null) }))));
        }
        return { workspaces, page: resource.page, hasMore: rows.length > 50 };
      }
    }
  },
};
