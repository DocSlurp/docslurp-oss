import { randomUUID } from "node:crypto";

import {
  effectiveGraphEntityTypes,
  estimateGraphBuild,
  getWorkspaceTemplate,
  graphConfigFingerprint,
  graphDepths,
  graphFallbackScope,
  isGraphJobActive,
  normalizePipelineFeatures,
  resolvePipelineTextModel,
  type GraphBuildCalibration,
  type GraphBuildEstimate,
  type GraphConfig,
  type GraphDepth,
  type GraphJob,
  type GraphRebuildMode,
  type PipelineFeatures,
  type StartGraphRebuildInput,
  type UpdateWorkspaceGraphInput,
  type WorkspaceGraphStatus,
  type WorkspaceRecord,
  PUBLIC_ERROR_MESSAGES,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { resolveApiAiUsagePricing } from "../lib/ai-usage.js";
import { canEditWorkspace, getWorkspaceAccess } from "./organizations.js";
import { getWorkspace, updateWorkspace } from "./workspaces.js";
import { costEstimateFromGraph } from "./jobs.js";

/**
 * Workspace Graph module: one knowledge graph per workspace, its settings,
 * coverage, cost/time estimates and rebuild jobs. The worker owns extraction
 * (worker/src/graph); this module only reads graph state and queues jobs.
 */

export class WorkspaceGraphError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly activeJob?: GraphJob,
  ) {
    super(message);
  }
}

type GraphJobRow = {
  id: string;
  workspace_id: string;
  mode: GraphRebuildMode;
  status: GraphJob["status"];
  phase: GraphJob["phase"];
  config: GraphConfig;
  config_hash: string;
  model: string;
  estimate: GraphBuildEstimate | Record<string, never>;
  max_cost_cents: string | number | null;
  documents_total: number;
  documents_processed: number;
  documents_failed: number;
  windows_processed: number;
  input_tokens: number;
  output_tokens: number;
  cost_cents: string | number;
  error: string | null;
  cancel_requested_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
};

function graphEnabled(pipeline: PipelineFeatures): boolean {
  return pipeline.graphRag || pipeline.entityIndex || pipeline.graphCommunitySummaries;
}

function graphModel(pipeline: PipelineFeatures): string {
  return resolvePipelineTextModel(pipeline, "graph-extraction", process.env.DOCSLURP_TEXT_MODEL?.trim() || undefined);
}

function workerConcurrency(): number {
  const parsed = Number.parseInt(process.env.WORKER_GRAPH_JOB_CONCURRENCY ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
}

export function mapGraphJob(row: GraphJobRow, now = Date.now()): GraphJob {
  const estimate = "windows" in row.estimate ? (row.estimate as GraphBuildEstimate) : null;
  const done = row.documents_processed + row.documents_failed;
  const remaining = Math.max(0, row.documents_total - done);
  let etaSeconds: number | null = null;
  if (row.status === "queued") {
    etaSeconds = estimate?.seconds ?? null;
  } else if (row.status === "running" && row.started_at && done > 0) {
    const elapsed = (now - row.started_at.getTime()) / 1000;
    etaSeconds = Math.round((elapsed / done) * remaining);
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    mode: row.mode,
    status: row.status,
    phase: row.phase,
    config: row.config,
    configHash: row.config_hash,
    model: row.model,
    estimate,
    maxCostCents: row.max_cost_cents === null ? null : Number(row.max_cost_cents),
    documentsTotal: row.documents_total,
    documentsProcessed: row.documents_processed,
    documentsFailed: row.documents_failed,
    windowsProcessed: row.windows_processed,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costCents: Number(row.cost_cents),
    etaSeconds,
    error: graphJobPublicError(row.status, row.error),
    cancelRequested: row.cancel_requested_at !== null,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

/** The worker writes two fixed cancellation notes; anything else it stored is internal error text. */
const GRAPH_CANCEL_NOTE = /^(?:Cancelled by request|Stopped at the \$\d[\d,]*(?:\.\d{2})? cost cap)$/;

/**
 * A graph job's `error` for API callers. Failure text from the worker stays in
 * graph_jobs and the worker log (raw errors go to telemetry, never to users);
 * callers get closed copy. The worker's own cancellation notes pass through.
 */
export function graphJobPublicError(status: string, stored: string | null): string | null {
  if (!stored) return null;
  if (status === "cancelled") return GRAPH_CANCEL_NOTE.test(stored) ? stored : null;
  if (status === "failed") return PUBLIC_ERROR_MESSAGES.graphRebuildFailed;
  return null;
}

async function requireWorkspace(workspaceRef: string, userId: string, edit: boolean): Promise<WorkspaceRecord> {
  const workspace = await getWorkspace(workspaceRef, userId);
  if (!workspace) throw new WorkspaceGraphError("Workspace not found", 404);
  if (edit) {
    const access = await getWorkspaceAccess(workspace.id, userId);
    if (!access || !canEditWorkspace(access, userId)) {
      throw new WorkspaceGraphError("You cannot change this workspace", 403);
    }
  }
  return workspace;
}

/** Observed tokens and seconds per window for documents built with `configHash`. */
async function calibrationFor(workspace: WorkspaceRecord, configHash: string): Promise<GraphBuildCalibration | null> {
  const [row] = await sql<{ windows: number; input: number; output: number; ms: number }[]>`
    select coalesce(sum(windows), 0)::int as windows, coalesce(sum(input_tokens), 0)::int as input,
      coalesce(sum(output_tokens), 0)::int as output, coalesce(sum(duration_ms), 0)::int as ms
    from (
      select s.windows, s.input_tokens, s.output_tokens, s.duration_ms
      from kg_document_state s
      join workspaces w on w.id = s.workspace_id
      where w.org_id = ${workspace.orgId} and s.config_hash = ${configHash} and s.source = 'llm' and s.windows > 0
      order by (s.workspace_id = ${workspace.id}) desc, s.extracted_at desc
      limit 500
    ) recent
  `;
  if (!row || row.windows === 0) return null;
  return {
    sampleWindows: row.windows,
    inputTokensPerWindow: row.input / row.windows,
    outputTokensPerWindow: row.output / row.windows,
    secondsPerWindow: row.ms / 1000 / row.windows,
  };
}

async function documentSizes(workspaceId: string, configHash: string) {
  return await sql<{ chars: number; current: boolean }[]>`
    select coalesce(sum(length(c.text)), 0)::int as chars, coalesce(bool_or(s.config_hash = ${configHash}), false) as current
    from documents d
    left join document_chunks c on c.document_id = d.id
    left join kg_document_state s on s.document_id = d.id
    where d.workspace_id = ${workspaceId} and d.status = 'completed' and d.superseded_at is null
    group by d.id
  `;
}

async function estimateFor(
  workspace: WorkspaceRecord,
  config: GraphConfig,
  model: string,
  sizes: Array<{ chars: number; current: boolean }>,
  mode: GraphRebuildMode,
): Promise<GraphBuildEstimate> {
  const configHash = graphConfigFingerprint(config, model);
  return estimateGraphBuild({
    documentChars: sizes.filter((size) => mode === "full" || !size.current).map((size) => size.chars),
    config,
    pricing: resolveApiAiUsagePricing(),
    concurrency: workerConcurrency(),
    calibration: await calibrationFor(workspace, configHash),
  });
}

async function jobRows(workspaceId: string) {
  const active = await sql<GraphJobRow[]>`
    select * from graph_jobs where workspace_id = ${workspaceId} and status in ('queued', 'running') limit 1
  `;
  const last = await sql<GraphJobRow[]>`
    select * from graph_jobs where workspace_id = ${workspaceId} and status not in ('queued', 'running')
    order by created_at desc limit 1
  `;
  return { active: active[0] ? mapGraphJob(active[0]) : null, last: last[0] ? mapGraphJob(last[0]) : null };
}

export async function getWorkspaceGraphStatus(workspaceRef: string, userId: string): Promise<WorkspaceGraphStatus> {
  const workspace = await requireWorkspace(workspaceRef, userId, false);
  return await buildGraphStatus(workspace);
}

async function buildGraphStatus(workspace: WorkspaceRecord): Promise<WorkspaceGraphStatus> {
  const pipeline = normalizePipelineFeatures(workspace.pipeline);
  const config = pipeline.graph;
  const model = graphModel(pipeline);
  const configHash = graphConfigFingerprint(config, model);

  const [counts] = await sql<{ entities: number; relationships: number; communities: number; mentions: number }[]>`
    select
      (select count(*)::int from kg_nodes where workspace_id = ${workspace.id}) as entities,
      (select count(*)::int from kg_edges where workspace_id = ${workspace.id}) as relationships,
      (select count(*)::int from kg_communities where workspace_id = ${workspace.id}) as communities,
      (select coalesce(sum(mention_count), 0)::int from kg_nodes where workspace_id = ${workspace.id}) as mentions
  `;
  const entityTypes = await sql<{ type: string; count: number }[]>`
    select entity_type as type, count(*)::int as count from kg_nodes
    where workspace_id = ${workspace.id}
    group by entity_type order by count desc, entity_type limit 16
  `;
  const [coverage] = await sql<{ documents: number; current: number; stale: number; missing: number; last: Date | null }[]>`
    select
      count(*)::int as documents,
      count(*) filter (where s.config_hash = ${configHash})::int as current,
      count(*) filter (where s.document_id is not null and s.config_hash <> ${configHash})::int as stale,
      count(*) filter (where s.document_id is null)::int as missing,
      max(s.extracted_at) as last
    from documents d
    left join kg_document_state s on s.document_id = d.id
    where d.workspace_id = ${workspace.id} and d.status = 'completed' and d.superseded_at is null
  `;

  const sizes = await documentSizes(workspace.id, configHash);
  const fullByDepth = {} as Record<GraphDepth, GraphBuildEstimate>;
  for (const depth of graphDepths) {
    fullByDepth[depth] = await estimateFor(workspace, { ...config, depth }, model, sizes, "full");
  }
  const jobs = await jobRows(workspace.id);

  return {
    workspaceId: workspace.id,
    enabled: graphEnabled(pipeline),
    config,
    configHash,
    model,
    effectiveEntityTypes: effectiveGraphEntityTypes(config),
    fallbackScope: graphFallbackScope({
      name: workspace.name,
      templateDescription: getWorkspaceTemplate(workspace.templateKey)?.description,
    }),
    stats: { ...counts!, entityTypes: [...entityTypes] },
    coverage: {
      documents: coverage?.documents ?? 0,
      current: coverage?.current ?? 0,
      stale: coverage?.stale ?? 0,
      missing: coverage?.missing ?? 0,
      lastExtractedAt: coverage?.last?.toISOString() ?? null,
    },
    estimates: {
      stale: await estimateFor(workspace, config, model, sizes, "stale"),
      full: fullByDepth[config.depth],
      fullByDepth,
    },
    activeJob: jobs.active,
    lastJob: jobs.last,
  };
}

/**
 * Partial graph settings update. Fields left out keep their value, so a
 * client never has to resend the rest of the pipeline. New settings apply to
 * new uploads immediately; existing documents become "stale" until rebuilt.
 */
export async function updateWorkspaceGraph(
  workspaceRef: string,
  userId: string,
  input: UpdateWorkspaceGraphInput,
): Promise<WorkspaceGraphStatus> {
  const workspace = await requireWorkspace(workspaceRef, userId, true);
  const pipeline = normalizePipelineFeatures(workspace.pipeline);
  const next = normalizePipelineFeatures({
    ...pipeline,
    graphRag: input.enabled ?? pipeline.graphRag,
    // Turning the graph off turns off everything that builds it.
    ...(input.enabled === false ? { entityIndex: false, graphCommunitySummaries: false } : {}),
    graph: {
      ...pipeline.graph,
      ...(input.domain !== undefined ? { domain: input.domain?.trim() || null } : {}),
      ...(input.entityTypes !== undefined ? { entityTypes: [...new Set(input.entityTypes)] } : {}),
      ...(input.depth !== undefined ? { depth: input.depth } : {}),
    },
  });
  if (next.graphRag && !next.embed) {
    throw new WorkspaceGraphError("The knowledge graph needs embeddings; enable embedding for this workspace first", 400);
  }
  const updated = await updateWorkspace(workspace.id, userId, { pipeline: next });
  if (!updated) throw new WorkspaceGraphError("Workspace not found", 404);
  return await buildGraphStatus(updated);
}

/** One computation of what a rebuild covers and costs; the estimate route and the rebuild both use it. */
async function planGraphRebuild(workspace: WorkspaceRecord, mode: GraphRebuildMode) {
  const pipeline = normalizePipelineFeatures(workspace.pipeline);
  if (!graphEnabled(pipeline)) {
    throw new WorkspaceGraphError("Enable the knowledge graph before rebuilding it", 409);
  }
  const config = pipeline.graph;
  const model = graphModel(pipeline);
  const configHash = graphConfigFingerprint(config, model);
  const sizes = await documentSizes(workspace.id, configHash);
  const estimate = await estimateFor(workspace, config, model, sizes, mode);
  const documentsTotal = mode === "full" ? sizes.length : sizes.filter((size) => !size.current).length;
  return { config, model, configHash, estimate, documentsTotal };
}

/** What a rebuild would cost and take, in the shared estimate shape (the rebuild's `job.estimate` is the same value). */
export async function estimateGraphRebuild(
  workspaceRef: string,
  userId: string,
  input: StartGraphRebuildInput,
  env: Record<string, string | undefined> = process.env,
) {
  const workspace = await requireWorkspace(workspaceRef, userId, true);
  return costEstimateFromGraph((await planGraphRebuild(workspace, input.mode)).estimate, env);
}

/** Queues a rebuild; one active job per workspace. `onEstimateTimed` receives the estimate's compute time (ms). */
export async function startGraphRebuild(
  workspaceRef: string,
  userId: string,
  input: StartGraphRebuildInput,
  options: { onEstimateTimed?: (ms: number) => void } = {},
): Promise<GraphJob> {
  const workspace = await requireWorkspace(workspaceRef, userId, true);
  const started = performance.now();
  const { config, model, configHash, estimate, documentsTotal } = await planGraphRebuild(workspace, input.mode);
  options.onEstimateTimed?.(performance.now() - started);
  if (documentsTotal === 0) {
    throw new WorkspaceGraphError(
      input.mode === "full" ? "This workspace has no documents to extract" : "Every document is already extracted with the current settings",
      409,
    );
  }

  try {
    const [row] = await sql<GraphJobRow[]>`
      insert into graph_jobs (
        id, org_id, workspace_id, user_id, mode, config, config_hash, model, estimate, max_cost_cents, documents_total
      )
      values (
        ${randomUUID()}, ${workspace.orgId}, ${workspace.id}, ${userId}, ${input.mode},
        ${sql.json(JSON.parse(JSON.stringify(config)))}, ${configHash}, ${model},
        ${sql.json(JSON.parse(JSON.stringify(estimate)))}, ${input.maxCostCents ?? null}, ${documentsTotal}
      )
      returning *
    `;
    return mapGraphJob(row!);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") {
      const { active } = await jobRows(workspace.id);
      throw new WorkspaceGraphError("A graph rebuild is already running for this workspace", 409, active ?? undefined);
    }
    throw error;
  }
}

export async function getGraphJob(workspaceRef: string, userId: string, jobId: string): Promise<GraphJob> {
  const workspace = await requireWorkspace(workspaceRef, userId, false);
  const [row] = await sql<GraphJobRow[]>`
    select * from graph_jobs where id = ${jobId} and workspace_id = ${workspace.id}
  `;
  if (!row) throw new WorkspaceGraphError("Graph job not found", 404);
  return mapGraphJob(row);
}

/** Queued jobs cancel at once; running jobs stop after their current batch. */
export async function cancelGraphJob(workspaceRef: string, userId: string, jobId: string): Promise<GraphJob> {
  const workspace = await requireWorkspace(workspaceRef, userId, true);
  const [row] = await sql<GraphJobRow[]>`
    update graph_jobs
    set status = case when status = 'queued' then 'cancelled' else status end,
        phase = case when status = 'queued' then 'done' else phase end,
        error = case when status = 'queued' then 'Cancelled by request' else error end,
        finished_at = case when status = 'queued' then now() else finished_at end,
        cancel_requested_at = coalesce(cancel_requested_at, now()),
        updated_at = now()
    where id = ${jobId} and workspace_id = ${workspace.id}
    returning *
  `;
  if (!row) throw new WorkspaceGraphError("Graph job not found", 404);
  return mapGraphJob(row);
}

export { isGraphJobActive };
