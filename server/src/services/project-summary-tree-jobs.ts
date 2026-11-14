import { randomUUID } from "node:crypto";

import {
  costEstimateSchema,
  EDITOR_REQUIRED_CODE,
  EDITOR_REQUIRED_MESSAGE,
  estimateSummaryTreeBuild,
  isBillingEnforced,
  isSummaryTreeJobActive,
  normalizePipelineFeatures,
  PUBLIC_ERROR_MESSAGES,
  resolveEmbeddingRoute,
  SUMMARY_TREE_BUILD_ENV_FLAG,
  SUMMARY_TREE_BUILD_STALE_MS,
  SUMMARY_TREE_BUILD_UNAVAILABLE_CODE,
  SUMMARY_TREE_JOB_NOTES,
  SUMMARY_TREE_REQUIRES_VECTORS_CODE,
  SUMMARY_TREE_REQUIRES_VECTORS_MESSAGE,
  summaryTreeBuildAvailable,
  summaryTreeBuildEstimateSchema,
  summaryTreeEnabled,
  summaryTreeVectorProblem,
  type CostEstimate,
  type PipelineFeatures,
  type ProjectRecord,
  type ProjectSummaryTreeBackfill,
  type StartSummaryTreeBackfillInput,
  type SummaryTreeBuildCalibration,
  type SummaryTreeBuildEstimate,
  type SummaryTreeJob,
  type SummaryTreeJobBlockedReason,
  type SummaryTreeJobStatus,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { resolveApiAiUsagePricing } from "../lib/ai-usage.js";
import { assertCanSpend } from "./billing/spend-guard.js";
import { canEditProject, getProjectAccess } from "./organizations.js";
import { SUMMARY_TREE_UNAVAILABLE_MESSAGE } from "./project-summary-tree.js";
import { getProject } from "./projects.js";

/**
 * Summary tree backfill jobs: the API side. A job builds trees for a project's already indexed documents; the worker
 * owns the build (worker/src/summary-tree/backfill-job.ts). This module plans (which documents, what it costs),
 * queues, reads and cancels jobs. Nothing here calls a model, and every query is scoped to the project and its
 * organization.
 */

type Env = Readonly<Record<string, string | undefined>>;

export class SummaryTreeJobError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly code?: string,
    readonly activeJob?: SummaryTreeJob,
  ) {
    super(message);
    this.name = "SummaryTreeJobError";
  }
}

type JobRow = {
  id: string;
  org_id: string;
  project_id: string;
  status: SummaryTreeJobStatus;
  blocked_reason: SummaryTreeJobBlockedReason | null;
  estimate: unknown;
  max_cost_cents: string | number;
  documents_total: number;
  documents_ready: number;
  documents_skipped: number;
  documents_partial: number;
  nodes_built: number;
  model_calls: number;
  input_tokens: string | number;
  output_tokens: string | number;
  cost_cents: string | number;
  error: string | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
};

const JOB_NOTES: readonly string[] = Object.values(SUMMARY_TREE_JOB_NOTES);

/**
 * A job's `error` for API callers. Failure text from the worker stays in the job row and the worker log; callers get
 * closed copy. The worker's own fixed notes (cancelled, stopped at the cap, tree turned off) pass through.
 */
export function summaryTreeJobPublicError(status: string, stored: string | null): string | null {
  if (!stored) return null;
  if (status === "cancelled") return JOB_NOTES.includes(stored) ? stored : null;
  if (status === "failed") return PUBLIC_ERROR_MESSAGES.summaryTreeBackfillFailed;
  return null;
}

export function mapSummaryTreeJob(row: JobRow, now = Date.now()): SummaryTreeJob {
  const parsed = summaryTreeBuildEstimateSchema.safeParse(row.estimate);
  const estimate = parsed.success ? parsed.data : null;
  const done = row.documents_ready + row.documents_skipped + row.documents_partial;
  const remaining = Math.max(0, row.documents_total - done);
  let etaSeconds: number | null = null;
  if (row.status === "queued") etaSeconds = estimate?.seconds ?? null;
  else if (row.status === "running" && row.started_at && done > 0) {
    etaSeconds = Math.round(((now - row.started_at.getTime()) / 1000 / done) * remaining);
  }
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status,
    blockedReason: row.status === "blocked" ? row.blocked_reason : null,
    estimate,
    maxCostCents: Number(row.max_cost_cents),
    documentsTotal: row.documents_total,
    documentsReady: row.documents_ready,
    documentsSkipped: row.documents_skipped,
    documentsPartial: row.documents_partial,
    nodesBuilt: row.nodes_built,
    modelCalls: row.model_calls,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    costCents: Number(row.cost_cents),
    etaSeconds,
    error: summaryTreeJobPublicError(row.status, row.error),
    cancelRequested: row.cancel_requested_at !== null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The estimate in the shared shape every job reports. Credits are cents, as for the other background jobs. */
export function costEstimateFromSummaryTree(estimate: SummaryTreeBuildEstimate, env: Env = process.env): CostEstimate {
  const billing = isBillingEnforced(env) ? "enforced" : "disabled";
  return costEstimateSchema.parse({
    pages: estimate.pages,
    documents: estimate.documentsToBuild,
    billing,
    credits: billing === "disabled" ? null : { low: estimate.costCentsLow, high: estimate.costCentsHigh },
    seconds: { low: estimate.secondsLow, high: estimate.secondsHigh },
    basis: `Summary tree, ${estimate.nodes} section summaries over ${estimate.leaves} passages in ${estimate.documentsToBuild} long documents; ${estimate.documents - estimate.documentsToBuild} shorter documents get none (${estimate.basis} timings)`,
  });
}

async function requireProject(projectRef: string, userId: string, edit: boolean): Promise<ProjectRecord> {
  const project = await getProject(projectRef, userId);
  if (!project) throw new SummaryTreeJobError("Project not found", 404);
  if (edit) {
    const access = await getProjectAccess(project.id, userId);
    if (!access || !canEditProject(access, userId)) throw new SummaryTreeJobError(EDITOR_REQUIRED_MESSAGE, 403, EDITOR_REQUIRED_CODE);
  }
  return project;
}

function workerConcurrency(env: Env): number {
  const parsed = Number.parseInt(env.WORKER_SUMMARY_TREE_CONCURRENCY ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(parsed, 32) : 4;
}

const numberStat = (name: string) => sql`case when jsonb_typeof(s.stats->${name}) = 'number' then (s.stats->>${name})::numeric else 0 end`;

/**
 * What finished builds measured, from the stats every build registers on the document's `summary-tree` stage row
 * (the stage and the backfill job both do). Whole builds only (every node written by a model call), this project's
 * first, then the organization's. Never another organization's.
 */
async function calibrationFor(project: ProjectRecord): Promise<SummaryTreeBuildCalibration | null> {
  const [row] = await sql<{ nodes: number; leaves: number; calls: number; input: number; output: number; ms: number }[]>`
    select coalesce(sum(nodes), 0)::float8 as nodes, coalesce(sum(leaves), 0)::float8 as leaves, coalesce(sum(calls), 0)::float8 as calls,
      coalesce(sum(input), 0)::float8 as input, coalesce(sum(output), 0)::float8 as output, coalesce(sum(ms), 0)::float8 as ms
    from (
      select ${numberStat("nodes")} as nodes, ${numberStat("leaves")} as leaves, ${numberStat("modelCalls")} as calls,
        ${numberStat("inputTokens")} as input, ${numberStat("outputTokens")} as output, ${numberStat("durationMs")} as ms
      from document_run_stage_states s
      join documents d on d.id = s.document_id
      where d.org_id = ${project.orgId} and s.stage_name = 'summary-tree' and s.status = 'completed'
        and s.stats->>'summaryTreeStatus' = 'ready'
        and ${numberStat("nodes")} > 0 and ${numberStat("generatedNodes")} = ${numberStat("nodes")}
      order by (d.project_id = ${project.id}) desc, s.completed_at desc nulls last
      limit 500
    ) recent
  `;
  if (!row || row.nodes <= 0 || row.leaves <= 0 || row.calls <= 0) return null;
  return {
    sampleNodes: row.nodes,
    nodesPerLeaf: row.nodes / row.leaves,
    callsPerNode: row.calls / row.nodes,
    inputTokensPerCall: row.input / row.calls,
    outputTokensPerCall: row.output / row.calls,
    secondsPerNode: row.ms / 1000 / row.nodes,
  };
}

/**
 * The project's current documents without a servable tree, with their leaf counts, from Postgres alone: no artifact
 * is read and no model is called. A leaf is a chunk of the document's current run that is neither an overlap chunk
 * nor a table row or cell chunk (the build's own rule). A document another build is working on right now is left out.
 * One aggregate over the chunks of the documents that need work; it uses `document_chunks (document_id, chunk_index)`.
 */
async function documentsToBackfill(project: ProjectRecord, pipeline: PipelineFeatures) {
  const route = resolveEmbeddingRoute(pipeline.embedding);
  return await sql<{ leaves: number; leaf_tokens: number; pages: number }[]>`
    with docs as (
      select d.id, d.run_id, coalesce(d.page_count, 0) as pages
      from documents d
      where d.org_id = ${project.orgId} and d.project_id = ${project.id}
        and d.status = 'completed' and d.superseded_at is null and d.purged_at is null and d.archived_at is null
        -- A corrected document gets no tree (the build cannot read corrected chunks), so there is nothing to backfill.
        and not exists (
          select 1 from document_corrections dc where dc.document_id = d.id and dc.reindex_completed_at is not null
        )
        and not exists (
          select 1 from document_summary_trees t
          where t.document_id = d.id and t.org_id = d.org_id and t.project_id = d.project_id and t.run_id = d.run_id
            and (
              t.status = 'skipped'
              or (t.status = 'ready' and t.built_at is not null
                and t.embedding_model = ${route.model} and t.dimension = ${route.dimensions})
              or (t.status = 'building' and t.updated_at > now() - ${`${SUMMARY_TREE_BUILD_STALE_MS} milliseconds`}::interval)
            )
        )
    )
    select coalesce(l.leaves, 0)::int as leaves, coalesce(l.tokens, 0)::float8 as leaf_tokens, docs.pages::float8 as pages
    from docs
    left join lateral (
      select count(*) as leaves, sum(c.token_estimate) as tokens
      from document_chunks c
      where c.document_id = docs.id and c.run_id = docs.run_id
        and coalesce(c.metadata ->> 'overlapIndex', '0') = '0'
        and coalesce(c.metadata ->> 'tableGranularity', '') not in ('row', 'cell')
    ) l on true
  `;
}

/** One computation of what a backfill covers and costs; the estimate route, the status and the start all use it. */
async function planBackfill(project: ProjectRecord, env: Env): Promise<SummaryTreeBuildEstimate> {
  const pipeline = normalizePipelineFeatures(project.pipeline);
  const documents = await documentsToBackfill(project, pipeline);
  return estimateSummaryTreeBuild({
    documents: documents.map((document) => ({ leaves: document.leaves, leafTokens: document.leaf_tokens, pages: document.pages })),
    pricing: resolveApiAiUsagePricing(),
    concurrency: workerConcurrency(env),
    calibration: await calibrationFor(project),
  });
}

/** Refuses unless the project has the tree on, with vectors, on a deployment that builds trees. */
function assertBuildable(project: ProjectRecord, env: Env): void {
  const pipeline = normalizePipelineFeatures(project.pipeline);
  if (!summaryTreeEnabled(pipeline)) throw new SummaryTreeJobError("Turn the summary tree on for this project before building it for existing documents", 409);
  if (summaryTreeVectorProblem(pipeline)) throw new SummaryTreeJobError(SUMMARY_TREE_REQUIRES_VECTORS_MESSAGE, 400, SUMMARY_TREE_REQUIRES_VECTORS_CODE);
  if (!summaryTreeBuildAvailable(env)) {
    console.warn(`[summary-tree] refused a backfill project=${project.id}: ${SUMMARY_TREE_BUILD_ENV_FLAG} is off`);
    throw new SummaryTreeJobError(SUMMARY_TREE_UNAVAILABLE_MESSAGE, 400, SUMMARY_TREE_BUILD_UNAVAILABLE_CODE);
  }
}

async function jobRows(project: ProjectRecord) {
  const active = await sql<JobRow[]>`
    select * from summary_tree_jobs
    where project_id = ${project.id} and org_id = ${project.orgId} and status in ('queued', 'running', 'blocked') limit 1
  `;
  const last = await sql<JobRow[]>`
    select * from summary_tree_jobs
    where project_id = ${project.id} and org_id = ${project.orgId} and status not in ('queued', 'running', 'blocked')
    order by created_at desc limit 1
  `;
  return { active: active[0] ? mapSummaryTreeJob(active[0]) : null, last: last[0] ? mapSummaryTreeJob(last[0]) : null };
}

/** What a job started now would cover and cost, plus the active and the last job. */
export async function getProjectSummaryTreeBackfill(projectRef: string, userId: string, env: Env = process.env): Promise<ProjectSummaryTreeBackfill> {
  const project = await requireProject(projectRef, userId, false);
  const jobs = await jobRows(project);
  return { projectId: project.id, estimate: await planBackfill(project, env), activeJob: jobs.active, lastJob: jobs.last };
}

/** The estimate of a backfill in the shared estimate shape (the started job's `job.estimate` is the same value). */
export async function estimateSummaryTreeBackfill(projectRef: string, userId: string, env: Env = process.env): Promise<CostEstimate> {
  const project = await requireProject(projectRef, userId, true);
  assertBuildable(project, env);
  return costEstimateFromSummaryTree(await planBackfill(project, env), env);
}

/**
 * Queues a backfill; one active job per project. Refused unless the tree is on for the project, the deployment
 * builds trees and the organization may spend. The cap is part of the request: there is no uncapped job.
 */
export async function startSummaryTreeBackfill(
  projectRef: string,
  userId: string,
  input: StartSummaryTreeBackfillInput,
  env: Env = process.env,
): Promise<SummaryTreeJob> {
  const project = await requireProject(projectRef, userId, true);
  assertBuildable(project, env);
  // Throws SpendBlockedError (402) when the organization may not start paid work.
  await assertCanSpend(project.orgId, project.id);
  const estimate = await planBackfill(project, env);
  if (estimate.documents === 0) throw new SummaryTreeJobError("Every document of this project already has a summary tree or needs none", 409);
  try {
    const [row] = await sql<JobRow[]>`
      insert into summary_tree_jobs (id, org_id, project_id, user_id, estimate, max_cost_cents, documents_total)
      values (
        ${randomUUID()}, ${project.orgId}, ${project.id}, ${userId},
        ${sql.json(JSON.parse(JSON.stringify(estimate)))}, ${input.maxCostCents}, ${estimate.documents}
      )
      returning *
    `;
    return mapSummaryTreeJob(row!);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      const { active } = await jobRows(project);
      throw new SummaryTreeJobError("A summary tree backfill is already running for this project", 409, undefined, active ?? undefined);
    }
    throw error;
  }
}

export async function getSummaryTreeJob(projectRef: string, userId: string, jobId: string): Promise<SummaryTreeJob> {
  const project = await requireProject(projectRef, userId, false);
  const [row] = await sql<JobRow[]>`
    select * from summary_tree_jobs where id = ${jobId} and project_id = ${project.id} and org_id = ${project.orgId}
  `;
  if (!row) throw new SummaryTreeJobError("Summary tree job not found", 404);
  return mapSummaryTreeJob(row);
}

/** A queued or parked job cancels at once; a running job stops before its next model call. */
export async function cancelSummaryTreeJob(projectRef: string, userId: string, jobId: string): Promise<SummaryTreeJob> {
  const project = await requireProject(projectRef, userId, true);
  const [row] = await sql<JobRow[]>`
    update summary_tree_jobs
    set status = case when status in ('queued', 'blocked') then 'cancelled' else status end,
        error = case when status in ('queued', 'blocked') then ${SUMMARY_TREE_JOB_NOTES.cancelled} else error end,
        finished_at = case when status in ('queued', 'blocked') then now() else finished_at end,
        blocked_reason = case when status = 'blocked' then null else blocked_reason end,
        resume_after = case when status = 'blocked' then null else resume_after end,
        cancel_requested_at = case when status in ('queued', 'blocked', 'running') then coalesce(cancel_requested_at, now()) else cancel_requested_at end,
        updated_at = now()
    where id = ${jobId} and project_id = ${project.id} and org_id = ${project.orgId}
    returning *
  `;
  if (!row) throw new SummaryTreeJobError("Summary tree job not found", 404);
  return mapSummaryTreeJob(row);
}

export { isSummaryTreeJobActive };
