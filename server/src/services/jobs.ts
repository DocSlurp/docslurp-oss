import {
  costEstimateSchema,
  isBillingEnforced,
  type CostEstimate,
  type GraphBuildEstimate,
  type JobKind,
  type JobStatus,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { apiKeyCanUseWorkspace, type ApiKeyWorkspaceScope } from "../lib/api-key-workspace-scope.js";
import { getWorkspaceAccess } from "./organizations.js";

/**
 * Shared job resource: a thin, read-only view over `workspace_runs` (re-index, full-index, reprocess,
 * backfill jobs) and `graph_jobs` (graph rebuilds). One job is one or more runs; the job id is the first
 * run's id and every run of the job carries `stats.job = { id, kind, estimate?, estimateUrl? }`.
 */

/** Inline estimates must compute within this budget; otherwise the job carries `estimateUrl`. */
export const INLINE_ESTIMATE_BUDGET_MS = 150;

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
  workspace_id: string;
  org_id: string;
  kind: string;
  status: string;
  blocked_reason: string | null;
  control_state: string | null;
  total_documents: number;
  processed_documents: number;
  pages_total: number;
  pages_processed: number;
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
      documents: rows.reduce((sum, row) => sum + row.processed_documents, 0),
      documentsTotal: rows.reduce((sum, row) => sum + row.total_documents, 0),
      pages: rows.reduce((sum, row) => sum + row.pages_processed, 0),
      pagesTotal: rows.reduce((sum, row) => sum + row.pages_total, 0),
    },
  };
}

type GraphJobRow = {
  id: string;
  org_id: string;
  workspace_id: string;
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

export const isJobTerminal = (job: Pick<JobStatus, "status">) =>
  job.status === "completed" || job.status === "failed" || job.status === "cancelled";

/**
 * Reads one job (a run, any run of a multi-run job, or a graph job) the user may see; null when it does not
 * exist or the workspace is not accessible. A single query reads the job's runs with their queue position.
 */
export async function getJobStatus(
  jobId: string,
  userId: string,
  options: { apiKey?: ApiKeyWorkspaceScope | null; env?: Record<string, string | undefined> } = {},
): Promise<JobStatusWithProgress | null> {
  const rows = await sql<JobRunRow[]>`
    select r.id, r.workspace_id, r.org_id, r.kind, r.status, r.blocked_reason, r.control_state,
      r.total_documents, r.processed_documents, r.pages_total, r.pages_processed,
      r.stats -> 'job' as job, r.job_id, r.created_at,
      (
        select count(*)::int from workspace_runs q
        where q.org_id = r.org_id and q.status in ('queued', 'processing') and q.kind <> 'materialize'
          and (q.created_at, q.id) < (r.created_at, r.id)
      ) as ahead
    from workspace_runs r
    where r.id = ${jobId} or r.job_id = ${jobId}
    order by r.created_at, r.id
  `;
  if (rows.length > 0) {
    const first = rows[0]!;
    if (options.apiKey && !apiKeyCanUseWorkspace(options.apiKey, { id: first.workspace_id, orgId: first.org_id })) return null;
    const access = await getWorkspaceAccess(first.workspace_id, userId);
    if (!access) return null;
    return jobFromRunRows(rows, first.job_id ?? first.id);
  }
  const [graph] = await sql<GraphJobRow[]>`
    select id, org_id, workspace_id, status, estimate, documents_total, documents_processed, documents_failed
    from graph_jobs where id = ${jobId}
  `;
  if (!graph) return null;
  if (options.apiKey && !apiKeyCanUseWorkspace(options.apiKey, { id: graph.workspace_id, orgId: graph.org_id })) return null;
  if (!(await getWorkspaceAccess(graph.workspace_id, userId))) return null;
  return jobFromGraphRow(graph, options.env);
}

/** Stamps job metadata on freshly created runs (before they start, so the worker reads it with the run). */
export async function recordJobMeta(runIds: string[], meta: JobMeta, client: typeof sql = sql): Promise<void> {
  if (runIds.length === 0) return;
  await client`
    update workspace_runs
    set job_id = ${meta.id},
        stats = coalesce(stats, '{}'::jsonb) || jsonb_build_object('job', ${client.json(JSON.parse(JSON.stringify(meta)))}::jsonb)
    where id = any(${runIds})
  `;
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
 * The estimate a mutation reports inline: computed (target loading included) within the budget, else null with
 * an `estimateUrl` to the matching estimate route.
 */
export async function inlineEstimate(
  compute: () => Promise<CostEstimate | null> | CostEstimate | null,
  estimateUrl: string,
  budgetMs = INLINE_ESTIMATE_BUDGET_MS,
): Promise<{ estimate: CostEstimate | null; estimateUrl?: string }> {
  const started = performance.now();
  const estimate = await compute();
  if (performance.now() - started > budgetMs) return { estimate: null, estimateUrl };
  return { estimate };
}

/** Job metadata from an inline estimate result. */
export function jobMetaFor(id: string, kind: JobKind, inline: { estimate: CostEstimate | null; estimateUrl?: string }): JobMeta {
  return { id, kind, estimate: inline.estimate, ...(inline.estimateUrl ? { estimateUrl: inline.estimateUrl } : {}) };
}

/** Whether `workspaceId` is visible to the user (job routes for graph jobs). */
export async function canSeeWorkspace(workspaceId: string, userId: string): Promise<boolean> {
  return Boolean(await getWorkspaceAccess(workspaceId, userId));
}
