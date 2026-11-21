import {
  costEstimateSchema,
  isBillingEnforced,
  summaryTreeBuildEstimateSchema,
  type CostEstimate,
  type GraphBuildEstimate,
  type JobKind,
  type JobStatus,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { apiKeyCanUseProject, type ApiKeyProjectScope } from "../lib/api-key-project-scope.js";
import { getProjectAccess } from "./organizations.js";
import { costEstimateFromSummaryTree } from "./project-summary-tree-jobs.js";

/**
 * Shared job resource: a thin, read-only view over `project_runs` (re-index, full-index, reprocess,
 * backfill jobs), `graph_jobs` (graph rebuilds) and `summary_tree_jobs` (summary tree backfills). One job is one or more runs; the job id is the first
 * run's id and every run of the job carries `stats.job = { id, kind, estimate?, estimateUrl? }`.
 */

export const jobStatusUrl = (id: string) => `/v1/jobs/${id}`;

export type JobMeta = {
  id: string;
  kind: JobKind;
  estimate?: CostEstimate | null;
  estimateUrl?: string;
};

export type JobProgress = {
  documents: number;
  documentsTotal: number;
  pages: number;
  pagesTotal: number;
};

export type JobStatusWithProgress = JobStatus & { progress: JobProgress };

type JobRunRow = {
  id: string;
  project_id: string;
  org_id: string;
  kind: string;
  status: string;
  blocked_reason: string | null;
  control_state: string | null;
  total_documents: number | string;
  processed_documents: number | string;
  pages_total: number | string;
  pages_processed: number | string;
  job: Partial<JobMeta> | null;
  job_id: string | null;
  ahead: number | string;
  created_at: Date | string;
};

const RUN_STATE: Record<string, JobStatus["status"]> = {
  queued: "queued",
  blocked: "blocked",
  processing: "processing",
  completed: "completed",
  failed: "failed",
};

function defaultKind(runKind: string): JobKind {
  return runKind === "full-index" ? "full-index" : runKind === "reindex" ? "reindex" : "reprocess";
}

/** Folds a job's runs into one state: any live run keeps the job live; blocked only when nothing else is running. */
export function foldRunStates(rows: Array<{ status: string; control_state: string | null }>): JobStatus["status"] {
  const states = rows.map((row): JobStatus["status"] => {
    if (row.control_state === "cancelled") return "cancelled";
    const state = RUN_STATE[row.status] ?? "queued";
    // A requested cancel is not an outcome: the run keeps working until it actually ends.
    return row.control_state === "cancel_requested" && (state === "queued" || state === "blocked") ? "processing" : state;
  });
  if (states.length === 0) return "queued";
  if (states.includes("processing")) return "processing";
  if (states.includes("queued")) return "queued";
  if (states.includes("blocked")) return "blocked";
  if (states.includes("failed")) return "failed";
  if (states.every((state) => state === "cancelled")) return "cancelled";
  return "completed";
}

/** Job status from already-loaded run rows. */
function jobFromRunRows(rows: JobRunRow[], jobId: string): JobStatusWithProgress {
  const first = rows.find((row) => row.id === jobId) ?? rows[0]!;
  const meta = rows.map((row) => row.job).find((job) => job && job.id === jobId) ?? null;
  const status = foldRunStates(rows);
  const blocked = rows.find((row) => row.status === "blocked");
  const ahead = status === "queued" || status === "blocked" ? Math.min(...rows.map((row) => Number(row.ahead))) : null;
  const estimate = meta?.estimate ? costEstimateSchema.safeParse(meta.estimate) : null;
  return {
    id: jobId,
    kind: meta?.kind ?? defaultKind(first.kind),
    status,
    ...(status === "blocked" && blocked?.blocked_reason ? { reason: blocked.blocked_reason as "credits" | "budget" | "policy" } : {}),
    queue: { position: status === "queued" && ahead !== null ? ahead + 1 : null, ahead: status === "queued" ? ahead : null },
    runIds: rows.map((row) => row.id),
    estimate: estimate?.success ? estimate.data : null,
    ...(meta?.estimateUrl ? { estimateUrl: meta.estimateUrl } : {}),
    statusUrl: jobStatusUrl(jobId),
    progress: {
      documents: rows.reduce((sum, row) => sum + Number(row.processed_documents), 0),
      documentsTotal: rows.reduce((sum, row) => sum + Number(row.total_documents), 0),
      pages: rows.reduce((sum, row) => sum + Number(row.pages_processed), 0),
      pagesTotal: rows.reduce((sum, row) => sum + Number(row.pages_total), 0),
    },
  };
}

type GraphJobRow = {
  id: string;
  org_id: string;
  project_id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  estimate: Record<string, unknown> | null;
  documents_total: number;
  documents_processed: number;
  documents_failed: number;
};

/** Graph build estimates are priced in cents (credits); time is the wall-clock range. */
export function costEstimateFromGraph(
  estimate: GraphBuildEstimate,
  env: Record<string, string | undefined> = process.env,
): CostEstimate {
  const billing = isBillingEnforced(env) ? "enforced" : "disabled";
  return costEstimateSchema.parse({
    pages: 0,
    documents: estimate.documents,
    billing,
    credits: billing === "disabled" ? null : { low: estimate.costCentsLow, high: estimate.costCentsHigh },
    seconds: { low: estimate.secondsLow, high: estimate.secondsHigh },
    basis: `Knowledge graph extraction, ${estimate.depth} depth, ${estimate.windows} windows (${estimate.basis} timings)`,
  });
}

function jobFromGraphRow(row: GraphJobRow, env: Record<string, string | undefined> = process.env): JobStatusWithProgress {
  const raw = row.estimate && "windows" in row.estimate ? (row.estimate as unknown as GraphBuildEstimate) : null;
  const state = { queued: "queued", running: "processing", completed: "completed", failed: "failed", cancelled: "cancelled" } as const;
  return {
    id: row.id,
    kind: "graph-rebuild",
    status: state[row.status],
    queue: { position: row.status === "queued" ? 1 : null, ahead: row.status === "queued" ? 0 : null },
    runIds: [],
    estimate: raw ? costEstimateFromGraph(raw, env) : null,
    statusUrl: jobStatusUrl(row.id),
    progress: {
      documents: row.documents_processed + row.documents_failed,
      documentsTotal: row.documents_total,
      pages: 0,
      pagesTotal: 0,
    },
  };
}

type SummaryTreeJobRow = {
  id: string;
  org_id: string;
  project_id: string;
  status: "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";
  blocked_reason: string | null;
  estimate: unknown;
  documents_total: number;
  documents_ready: number;
  documents_skipped: number;
  documents_partial: number;
};

/** A parked summary tree job's reason in the shared vocabulary. */
const SUMMARY_TREE_BLOCKED_REASON: Record<string, NonNullable<JobStatus["reason"]>> = {
  "build-off": "unavailable",
  balance: "capacity",
  credits: "credits",
  policy: "policy",
  // The deployment has no price for the tree: nothing the caller can change.
  unpriced: "unavailable",
};

function jobFromSummaryTreeRow(row: SummaryTreeJobRow, env: Record<string, string | undefined> = process.env): JobStatusWithProgress {
  const raw = summaryTreeBuildEstimateSchema.safeParse(row.estimate);
  const state = { queued: "queued", running: "processing", blocked: "blocked", completed: "completed", failed: "failed", cancelled: "cancelled" } as const;
  const reason = row.status === "blocked" ? SUMMARY_TREE_BLOCKED_REASON[row.blocked_reason ?? ""] : undefined;
  return {
    id: row.id,
    kind: "summary-tree-backfill",
    status: state[row.status],
    ...(reason ? { reason } : {}),
    queue: { position: row.status === "queued" ? 1 : null, ahead: row.status === "queued" ? 0 : null },
    runIds: [],
    estimate: raw.success ? costEstimateFromSummaryTree(raw.data, env) : null,
    statusUrl: jobStatusUrl(row.id),
    progress: {
      documents: row.documents_ready + row.documents_skipped + row.documents_partial,
      documentsTotal: row.documents_total,
      pages: 0,
      pagesTotal: 0,
    },
  };
}

export const isJobTerminal = (job: Pick<JobStatus, "status">) =>
  job.status === "completed" || job.status === "failed" || job.status === "cancelled";

/**
 * Reads one job (a run, any run of a multi-run job, a graph job or a summary tree job) the user may see; null when
 * it does not exist or the project is not accessible. A summary tree job is never readable with a client key. A single query reads the job's runs with their queue position.
 */
export async function getJobStatus(
  jobId: string,
  userId: string,
  options: { apiKey?: ApiKeyProjectScope | null; env?: Record<string, string | undefined> } = {},
): Promise<JobStatusWithProgress | null> {
  const rows = await sql<JobRunRow[]>`
    select r.id, r.project_id, r.org_id, r.kind, r.status, r.blocked_reason, r.control_state,
      r.total_documents, r.processed_documents, r.pages_total, r.pages_processed,
      r.stats -> 'job' as job, r.job_id, r.created_at,
      (
        select count(*)::int from project_runs q
        where q.org_id = r.org_id and q.status in ('queued', 'processing') and q.kind <> 'materialize'
          and (q.created_at, q.id) < (r.created_at, r.id)
      ) as ahead
    from project_runs r
    where r.id = ${jobId} or r.job_id = ${jobId}
    order by r.created_at, r.id
  `;
  if (rows.length > 0) {
    // Every run is authorized on its own: a job id shared by runs of several projects (or, historically, several
    // organizations) only reports the runs this caller and key may see, never another tenant's ids or counts.
    const allowed = new Map<string, boolean>();
    for (const row of rows) {
      if (allowed.has(row.project_id)) continue;
      const keyAllows = !options.apiKey || apiKeyCanUseProject(options.apiKey, { id: row.project_id, orgId: row.org_id });
      allowed.set(row.project_id, keyAllows && Boolean(await getProjectAccess(row.project_id, userId)));
    }
    const visible = rows.filter((row) => allowed.get(row.project_id) === true);
    if (visible.length === 0) return null;
    const first = visible[0]!;
    return jobFromRunRows(visible, first.job_id ?? first.id);
  }
  const [graph] = await sql<GraphJobRow[]>`
    select id, org_id, project_id, status, estimate, documents_total, documents_processed, documents_failed
    from graph_jobs where id = ${jobId}
  `;
  if (graph) {
    if (options.apiKey && !apiKeyCanUseProject(options.apiKey, { id: graph.project_id, orgId: graph.org_id })) return null;
    if (!(await getProjectAccess(graph.project_id, userId))) return null;
    return jobFromGraphRow(graph, options.env);
  }
  const [tree] = await sql<SummaryTreeJobRow[]>`
    select id, org_id, project_id, status, blocked_reason, estimate, documents_total, documents_ready, documents_skipped, documents_partial
    from summary_tree_jobs where id = ${jobId}
  `;
  if (!tree) return null;
  // The same answer for a job that does not exist and one the caller may not see.
  // A summary tree job's status and estimate are read with a server key, as under the project's own route
  // (routes/project-summary-tree.ts): a browser (client) key gets nothing here, whatever its scopes.
  if (options.apiKey && options.apiKey.keyType !== "server") return null;
  if (options.apiKey && !apiKeyCanUseProject(options.apiKey, { id: tree.project_id, orgId: tree.org_id })) return null;
  if (!(await getProjectAccess(tree.project_id, userId))) return null;
  return jobFromSummaryTreeRow(tree, options.env);
}

/** Stamps job metadata on freshly created runs (before they start, so the worker reads it with the run). */
export async function recordJobMeta(runIds: string[], meta: JobMeta, client: typeof sql = sql): Promise<void> {
  if (runIds.length === 0) return;
  // A job never spans organizations (a null org counts as its own). The check is part of the same statement, so it
  // costs no extra round trip: a mixed set updates nothing and is refused.
  const updated = await client`
    update project_runs
    set job_id = ${meta.id},
        stats = coalesce(stats, '{}'::jsonb) || jsonb_build_object('job', ${client.json(JSON.parse(JSON.stringify(meta)))}::jsonb)
    where id = any(${runIds})
      and (select count(distinct coalesce(org_id, '')) from project_runs where id = any(${runIds})) <= 1
  `;
  if (updated.count === 0) {
    const [scope] = await client<{ orgs: number }[]>`select count(distinct coalesce(org_id, ''))::int as orgs from project_runs where id = any(${runIds})`;
    if ((scope?.orgs ?? 0) > 1) throw new Error("recordJobMeta refused: a job's runs must belong to one organization");
  }
}

/**
 * The `job` a mutation returns: read back from the stored runs so it matches `GET /v1/jobs/:id`.
 * Falls back to a synthetic queued status if the read fails.
 */
export async function jobStatusForMutation(
  meta: JobMeta,
  runIds: string[],
  userId: string,
): Promise<JobStatus> {
  const read = await getJobStatus(meta.id, userId).catch(() => null);
  if (read) {
    const { progress: _progress, ...status } = read;
    return status;
  }
  return {
    id: meta.id,
    kind: meta.kind,
    status: "queued",
    queue: { position: null, ahead: null },
    runIds,
    estimate: meta.estimate ?? null,
    ...(meta.estimateUrl ? { estimateUrl: meta.estimateUrl } : {}),
    statusUrl: jobStatusUrl(meta.id),
  };
}

/**
 * The estimate a mutation reports inline: the same estimate its estimate route (`estimateUrl`) returns, target loading
 * included. The mutation waits for it either way, so a computed estimate is never dropped for being slow; null only when
 * the work has none.
 */
export async function inlineEstimate(
  compute: () => Promise<CostEstimate | null> | CostEstimate | null,
  estimateUrl: string,
): Promise<{ estimate: CostEstimate | null; estimateUrl?: string }> {
  const estimate = await compute();
  return { estimate, estimateUrl };
}

/** Job metadata from an inline estimate result. */
export function jobMetaFor(id: string, kind: JobKind, inline: { estimate: CostEstimate | null; estimateUrl?: string }): JobMeta {
  return { id, kind, estimate: inline.estimate, ...(inline.estimateUrl ? { estimateUrl: inline.estimateUrl } : {}) };
}

/** Whether `projectId` is visible to the user (job routes for graph jobs). */
export async function canSeeProject(projectId: string, userId: string): Promise<boolean> {
  return Boolean(await getProjectAccess(projectId, userId));
}
