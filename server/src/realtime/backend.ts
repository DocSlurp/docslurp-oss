import { realtimeSuggestionsSnapshotSchema } from "@docslurp/shared";
import { readWorkspaceSuggestions } from "../services/workspace-suggestions.js";
import type { RealtimeBackend, DashboardResource } from "./broker.js";
import { sql } from "../db.js";
import { getWorkspaceAccess } from "../services/organizations.js";
import { workspaceUsageTotals, runUsageCostSummaries } from "../services/usage-attribution.js";
import { getBillingOverview } from "../services/billing/overview.js";
import { getWorkspace } from "../services/workspaces.js";
import { listDocumentIndexEntries, getRealtimeViewerPayload } from "../services/documents.js";
import { mapWorkspaceRun, type WorkspaceRunRow } from "../services/run-records.js";
import { buildRunProgressSnapshot } from "../services/runs.js";

async function authorize(userId: string, resource: DashboardResource): Promise<string | null> {
  if (resource.kind === "activity" || resource.kind === "billing" || resource.kind === "economics") {
    const [membership] = await sql<{ role: string }[]>`select role from org_memberships where user_id = ${userId} and org_id = ${resource.orgId}`;
    if (!membership || ((resource.kind === "billing" || resource.kind === "economics") && !["owner", "admin"].includes(membership.role))) return null;
    return resource.orgId;
  }
  let workspaceId: string;
  if (resource.kind === "viewer") {
    const [document] = await sql<{ workspace_id: string }[]>`select workspace_id from documents where id=${resource.documentId}`;
    if (!document) return null;
    workspaceId = document.workspace_id;
  } else if (resource.kind === "run") {
    const [run] = await sql<{ workspace_id: string }[]>`select workspace_id from workspace_runs where id = ${resource.runId}`;
    if (!run) return null;
    workspaceId = run.workspace_id;
  } else workspaceId = resource.workspaceId;
  return (await getWorkspaceAccess(workspaceId, userId))?.orgId ?? null;
}

export const realtimeBackend: RealtimeBackend = {
  authorize,
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
