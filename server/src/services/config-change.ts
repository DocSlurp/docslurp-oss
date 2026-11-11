import { randomUUID } from "node:crypto";

import {
  assertPipelineSpeedBoost,
  mergePipelineFeatures, type PipelineFeatureOverrides,
  analyzePipelineChange,
  CHART_EXPORT_CHARGING_STAGES,
  chartExportConfigOf,
  speedBoostMultiplier,
  compilePipelinePlan,
  deferredProfilesEnabled,
  effectiveIndexingMode,
  estimatePipelineWork,
  indexConfigHash,
  indexConfigOf,
  isBillingEnforced,
  pipelineStageOrder,
  updateProjectSchema,
  withoutStageSelection,
  type ConfigChangeImpact,
  type CostEstimate,
  type IndexConfig,
  type JobStatus,
  type PipelineFeatures,
  type PipelineRunStage,
  type UpdateProjectInput,
  type ProjectRecord,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { loadVisualStatsForEstimate, VISUAL_CANDIDATES_DOCUMENT_LIMIT, type VisualEstimateStats } from "./visual-candidates.js";
import { assertChartExportChangeAllowed } from "./chart-export-availability.js";
import { notifySearchEligibilityChanged } from "../search/eligibility-hint.js";
import { nextVersionNumber } from "./version-number.js";
import { validateModeSwitch } from "./project-indexing-mode.js";
import { signalPipelineCancel } from "../lib/temporal.js";
import { admissionBlock, requireRunCreditLease, isSpendBlockedError, spendBlockJobReason, spendGuardsSkipped } from "./billing/spend-guard.js";
import { creditLeasesEnabled } from "./billing/credit-leases.js";
import { getProjectAccess, canEditProject } from "./organizations.js";
import {
  jobStatusForMutation,
  recordJobMeta,
  type JobMeta,
} from "./jobs.js";
import { enforceLiveBudgetCaps } from "./run-creation.js";
import { assertBackfillReusableMany, isReprocessRejectedError } from "./runs.js";
import { getProject, resolveUpdatedPipeline, updateProject, type ProjectUpdateOptions } from "./projects.js";

/**
 * Config-change jobs (spec 6.2). A project PATCH is classified by `analyzePipelineChange`; changes that
 * make the existing index inconsistent ("reindex-required") save and automatically queue a minimal re-index,
 * "reindex-recommended" changes re-index on request. The change is never rejected: if spend admission blocks
 * the job, the config is still saved and the runs wait as `blocked` until the org can spend again.
 */

type Tx = Parameters<Parameters<typeof sql.begin>[1]>[0];

/** Documents a re-index job may carry; larger corpora get several runs. */
export const MAX_DOCUMENTS_PER_REINDEX_RUN = 1_000;

export type ReindexTarget = {
  id: string;
  org_id: string;
  user_id: string;
  project_id: string;
  run_id: string;
  filename: string;
  mime_type: string;
  source_key: string;
  extraction_mode: string;
  page_count: number;
  /** The worker's measured count (migration 0126), its method, intake's count source and the file facts: copied to the new version. */
  billing_pages: number | null;
  billing_pages_method: string | null;
  page_count_source: string | null;
  file_facts: unknown;
  canonical_id: string | null;
  version_number: number | null;
  source_sha256: string | null;
  source_path: string | null;
  index_config_hash: string | null;
};

/** Pages a document bills: the worker's measured count of an Office, slide, sheet or EPUB file, else its page count. */
export function billedPages(doc: { page_count: number | null; billing_pages?: number | null }): number {
  const measured = Number(doc.billing_pages);
  return Math.max(0, measured > 0 ? measured : Number(doc.page_count) || 0);
}

export type ReindexMode = "required" | "recommended";

export type ProjectChangePlan = {
  project: ProjectRecord;
  input: UpdateProjectInput;
  nextPipeline: PipelineFeatures;
  impact: ConfigChangeImpact;
  /** What re-indexing means for this change; null when existing documents are unaffected. */
  reindex: ReindexMode | null;
  /** Whether this request queues the re-index job. */
  willReindex: boolean;
  /** The index config changed (embedding, chunking or vector backend). */
  hashChanged: boolean;
  /** Existing vectorized documents keep their old index until re-indexed, so the change is recorded in `index_configs`. */
  recordsIndexChange: boolean;
  beforeConfig: IndexConfig;
  afterConfig: IndexConfig;
  targets: ReindexTarget[];
  /** Estimate of the re-index work; null when the change creates none. */
  estimate: CostEstimate | null;
  /** The project row's `updated_at` when planned; apply re-plans if another change landed since. */
  rowVersion: string | null;
};

export type EstimateEnv = Record<string, string | undefined>;

const LIVE_DOCUMENT = sql`d.status = 'completed' and d.superseded_at is null and d.purged_at is null and d.archived_at is null`;

/**
 * Live documents a re-index applies to: full-indexed, completed, not already being re-indexed.
 * `ignoreReindexRuns` treats documents queued in other `reindex` runs as free (a newer required change
 * cancels those runs and re-queues every document).
 */
async function loadTargets(
  client: typeof sql | Tx,
  projectId: string,
  options: { hashNot: string | null; ignoreReindexRuns?: boolean },
): Promise<ReindexTarget[]> {
  const db = client as typeof sql;
  const busyKinds = options.ignoreReindexRuns ? ["full-index"] : ["reindex", "full-index"];
  return await db<ReindexTarget[]>`
    select d.id, d.org_id, d.user_id, d.project_id, d.run_id, d.filename, d.mime_type, d.source_key,
      d.extraction_mode, d.page_count, d.billing_pages, d.billing_pages_method, d.page_count_source, d.file_facts,
      d.canonical_id, d.version_number, d.source_sha256, d.source_path, d.index_config_hash
    from documents d
    where d.project_id = ${projectId}
      and ${LIVE_DOCUMENT}
      and (d.indexing_mode is null or d.indexing_mode = 'full')
      -- Extract documents are never re-indexed: the new version would outlive the extract.
      and not exists (select 1 from project_runs xr where xr.id = d.run_id and xr.extract_id is not null)
      ${options.hashNot ? db`and d.index_config_hash is distinct from ${options.hashNot}` : db``}
      and not exists (
        select 1 from documents child
        join project_runs r on r.id = child.run_id
        where child.previous_version_id = d.id and child.status not in ('completed', 'failed', 'cancelled')
          and r.kind = any(${busyKinds}) and r.status in ('queued', 'blocked', 'processing')
      )
    order by d.created_at, d.id
  `;
}

/** Whether any live vectorized document exists (so an index-config change must be recorded). */
async function hasVectorizedDocuments(client: typeof sql | Tx, projectId: string): Promise<boolean> {
  const db = client as typeof sql;
  const [row] = await db<{ present: boolean }[]>`
    select exists (
      select 1 from documents d
      where d.project_id = ${projectId} and ${LIVE_DOCUMENT}
        and (d.indexing_mode is null or d.indexing_mode = 'full')
        and exists (select 1 from vector_indexes v where v.document_id = d.id)
    ) as present
  `;
  return Boolean(row?.present);
}

/** The org's concurrent worker ceiling (starter 50, funded 250, or a raised custom value). */
export async function orgWorkerSlots(orgId: string): Promise<number | undefined> {
  const [row] = await sql<{ worker_slots: number | null }[]>`select worker_slots from organizations where id = ${orgId}`;
  return row?.worker_slots ? Number(row.worker_slots) : undefined;
}

/** Prices `stages` over the given documents; shared by every estimate route and mutation. */
export async function estimateWork(args: {
  features: PipelineFeatures;
  stages: readonly PipelineRunStage[];
  documents: number;
  pages: number;
  orgId: string;
  env?: EstimateEnv;
  /**
   * The documents being estimated, so chart export prices their recorded visual counts instead of the per-page prior
   * (only when every one of them has recorded stats). Read scoped to `orgId` and `projectId`.
   */
  visualScope?: { projectId: string; documentIds: readonly string[] };
}): Promise<CostEstimate> {
  const [workerSlots, visualStats] = await Promise.all([orgWorkerSlots(args.orgId), recordedVisualStats(args)]);
  const estimate = estimatePipelineWork({
    features: args.features,
    stages: args.stages,
    documents: args.documents,
    pages: args.pages,
    workerSlots,
    env: args.env ?? process.env,
    ...(visualStats ? { visualStats } : {}),
  });
  const multiplier = speedBoostMultiplier(args.features.speedBoost);
  return { ...estimate, credits: estimate.credits ? { low: estimate.credits.low * multiplier, high: estimate.credits.high * multiplier } : null };
}

/** Recorded visual stats for an estimate's documents, or null (prior) when export is off or any document lacks them. */
async function recordedVisualStats(args: Parameters<typeof estimateWork>[0]): Promise<VisualEstimateStats | null> {
  const scope = args.visualScope;
  if (!scope || !chartExportConfigOf(args.features) || !args.stages.some((stage) => CHART_EXPORT_CHARGING_STAGES.includes(stage))) return null;
  const ids = [...new Set(scope.documentIds)];
  if (ids.length === 0 || ids.length > VISUAL_CANDIDATES_DOCUMENT_LIMIT) return null;
  try {
    const stats = await loadVisualStatsForEstimate({ orgId: args.orgId, projectId: scope.projectId, documentIds: ids });
    return stats.documents >= ids.length ? stats : null;
  } catch (error) {
    console.warn(`[estimate] visual stats unavailable project=${scope.projectId} error=${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * The stages a run with this stage subset actually executes: the subset plus the stages the pipeline's data flow
 * forces (`alwaysRerun` and dependency closure), compiled exactly as the worker compiles the run. Estimates and
 * displayed stage lists use this, never the raw change-impact stages, so what is priced is what runs.
 */
export function compiledStages(pipeline: PipelineFeatures, stages: readonly PipelineRunStage[]): PipelineRunStage[] {
  if (stages.length === 0) return [];
  return compilePipelinePlan({ ...withoutStageSelection(pipeline), stageSubset: [...stages] } as PipelineFeatures).stageOrder;
}

/** Combines per-group estimates (same billing mode) into one. */
export function sumEstimates(parts: CostEstimate[]): CostEstimate | null {
  const first = parts[0];
  if (!first) return null;
  const add = (pick: (e: CostEstimate) => { low: number; high: number } | null) => {
    const values = parts.map(pick);
    if (values.some((value) => value === null)) return null;
    return { low: values.reduce((sum, v) => sum + v!.low, 0), high: values.reduce((sum, v) => sum + v!.high, 0) };
  };
  return {
    pages: parts.reduce((sum, e) => sum + e.pages, 0),
    documents: parts.reduce((sum, e) => sum + e.documents, 0),
    billing: first.billing,
    credits: first.billing === "disabled" ? null : add((e) => e.credits),
    seconds: add((e) => e.seconds),
    basis: first.basis,
  };
}

/** Whether this request re-indexes recommended changes: explicit `apply`, else the project/request auto-confirm default. */
export function resolveApply(input: UpdateProjectInput, project: Pick<ProjectRecord, "autoConfirmReindex">): "reindex" | "new-uploads" {
  if (input.apply) return input.apply;
  return (input.autoConfirmReindex ?? project.autoConfirmReindex ?? false) ? "reindex" : "new-uploads";
}

/**
 * Classifies a project PATCH without changing anything. The estimate route returns exactly this plan's
 * `impact` and `estimate`; the mutation acts on the same plan.
 */
export async function planProjectChange(args: {
  projectId: string;
  userId: string;
  input: UpdateProjectInput;
  indexingMode?: PipelineFeatures["indexingMode"];
  env?: EstimateEnv;
  /** Merge a narrow trusted proposal against the same project snapshot this plan versions. */
  pipelineOverrides?: PipelineFeatureOverrides;
}): Promise<ProjectChangePlan | null> {
  const input = updateProjectSchema.parse(args.input);
  // Read before the project: a change landing in between only makes apply re-plan, never apply stale data.
  const rowVersion = await projectRowVersion(sql, args.projectId);
  const project = await getProject(args.projectId, args.userId);
  if (!project) return null;
  if (args.pipelineOverrides) input.pipeline = mergePipelineFeatures(project.pipeline, args.pipelineOverrides);
  const nextPipeline = await resolveUpdatedPipeline(project.id, project, input, { indexingMode: args.indexingMode });
  // The deployment kill switch: chart export cannot be turned on while it is off (a stored "on" stays inert).
  assertChartExportChangeAllowed(project.pipeline, nextPipeline, args.env ?? process.env);
  const base = analyzePipelineChange(project.pipeline, nextPipeline, { documents: 0, pages: 0 });
  const reindex: ReindexMode | null =
    base.kind === "reindex-required" ? "required" : base.kind === "reindex-recommended" ? "recommended" : null;

  const beforeConfig = indexConfigOf(project.pipeline);
  const afterConfig = indexConfigOf(nextPipeline);
  const hashChanged = indexConfigHash(beforeConfig) !== indexConfigHash(afterConfig);
  let targets: ReindexTarget[] = [];
  if (reindex) {
    // Only an index-config change makes documents' stored hash meaningful; other changes (PII policy,
    // summaries, ...) re-run the affected stages over every live document.
    targets = await loadTargets(sql, project.id, {
      hashNot: reindex === "required" && hashChanged ? indexConfigHash(afterConfig) : null,
      ignoreReindexRuns: reindex === "required" && hashChanged,
    });
  }
  const recordsIndexChange = hashChanged && (targets.length > 0 || (await hasVectorizedDocuments(sql, project.id)));
  const pages = targets.reduce((sum, doc) => sum + Math.max(0, doc.page_count ?? 0), 0);
  const impact: ConfigChangeImpact = reindex
    ? { ...base, stages: compiledStages(nextPipeline, base.stages), documents: targets.length, pages }
    : base;
  const willReindex = reindex === "required" || (reindex === "recommended" && resolveApply(input, project) === "reindex");

  let estimate: CostEstimate | null = null;
  if (reindex && targets.length > 0 && impact.stages.length > 0) {
    // Price what will be queued: documents whose in-flight re-index runs get cancelled owe those runs' stages too.
    const carry: StageCarry = reindex === "required" && hashChanged ? await loadStageCarry(sql, project.id) : new Map();
    const groups = new Map<string, { stages: PipelineRunStage[]; documents: number; pages: number; documentIds: string[] }>();
    const everything = compilePipelinePlan(nextPipeline).stageOrder;
    for (const doc of targets) {
      const owed = stagesFor(doc.id, impact.stages, carry);
      const stages = owed ? compiledStages(nextPipeline, owed) : everything;
      const group = groups.get(stages.join(",")) ?? { stages, documents: 0, pages: 0, documentIds: [] };
      group.documents += 1;
      group.documentIds.push(doc.id);
      // Priced on the pages the document bills, not the page basis its text splits into (one page for a measured DOCX).
      group.pages += billedPages(doc);
      groups.set(stages.join(","), group);
    }
    const parts: CostEstimate[] = [];
    for (const group of groups.values()) {
      parts.push(await estimateWork({
        features: { ...nextPipeline, speedBoost: input.speedBoost === true }, stages: group.stages, documents: group.documents, pages: group.pages, orgId: project.orgId, env: args.env,
        visualScope: { projectId: project.id, documentIds: group.documentIds },
      }));
    }
    estimate = parts.length === 1 ? parts[0]! : sumEstimates(parts);
  }
  return {
    project, input, nextPipeline, impact, reindex,
    willReindex: willReindex && targets.length > 0 && impact.stages.length > 0,
    hashChanged, recordsIndexChange, beforeConfig, afterConfig, targets, estimate, rowVersion,
  };
}

async function projectRowVersion(client: typeof sql | Tx, projectId: string): Promise<string | null> {
  const [row] = await (client as typeof sql)<{ version: string }[]>`select updated_at::text as version from projects where id = ${projectId}`;
  return row?.version ?? null;
}

/** Another change was saved after this plan was computed, so its pipeline and current values are stale. */
const STALE_PLAN = Symbol("stale-plan");

/** The project kept changing while a change was saved; the client can retry. */
export class ConfigConflictError extends Error {
  readonly status = 409 as const;
  readonly code = "config_conflict" as const;
  constructor() { super("The project changed repeatedly while saving; retry the request."); }
}
const MAX_REPLANS = 5;

export type ReindexRunResult = { runIds: string[]; queuedRunIds: string[]; blockedReason: "credits" | "budget" | "policy" | null; documents: number };

/**
 * Creates the minimal-stage re-index runs inside `tx`. Documents whose source artifacts can no longer be
 * reused (purged by retention) re-run the whole pipeline in a separate run instead of failing the job.
 * `blocked` runs are admitted later by the recovery sweeper.
 */
export async function createReindexRuns(args: {
  tx: Tx;
  project: ProjectRecord;
  pipeline: PipelineFeatures;
  userId: string;
  meta: Omit<JobMeta, "id">;
  blockedReason: "credits" | "budget" | "policy" | null;
  /** Partial groups re-run `stages` over documents seeded from their source run; `full` re-runs everything. */
  reusable: ReusableSplit;
}): Promise<ReindexRunResult> {
  assertPipelineSpeedBoost(args.pipeline);
  const { tx, project } = args;
  const runIds: string[] = [];
  const queuedRunIds: string[] = [];
  let blockedReason = args.blockedReason;
  const batches: Array<{ docs: ReindexTarget[]; pipeline: PipelineFeatures; partial: boolean }> = [];
  const fullPipeline = { ...withoutStageSelection(args.pipeline) } as PipelineFeatures;
  for (const group of args.reusable.partial) {
    const pipeline = { ...withoutStageSelection(args.pipeline), stageSubset: [...group.stages] } as PipelineFeatures;
    for (let i = 0; i < group.docs.length; i += MAX_DOCUMENTS_PER_REINDEX_RUN) {
      batches.push({ docs: group.docs.slice(i, i + MAX_DOCUMENTS_PER_REINDEX_RUN), pipeline, partial: true });
    }
  }
  for (let i = 0; i < args.reusable.full.length; i += MAX_DOCUMENTS_PER_REINDEX_RUN) {
    batches.push({ docs: args.reusable.full.slice(i, i + MAX_DOCUMENTS_PER_REINDEX_RUN), pipeline: fullPipeline, partial: false });
  }
  const jobId = randomUUID();
  let documents = 0;
  for (const [index, batch] of batches.entries()) {
    // Recheck under the org admission lock for every batch. Earlier batches in
    // this transaction already hold their own reservation/lease; a single
    // check for the whole job would over-admit large projects.
    let batchBlockedReason = args.blockedReason;
    if (!batchBlockedReason) {
      const block = await admissionBlock(tx, project.orgId, project.id, { speedBoost: batch.pipeline.speedBoost });
      if (block) batchBlockedReason = spendBlockJobReason(block.code);
    }
    const status = batchBlockedReason ? "blocked" : "queued";
    const runId = index === 0 ? jobId : randomUUID();
    const pages = batch.docs.reduce((sum, doc) => sum + Math.max(0, doc.page_count ?? 0), 0);
    const stats = { job: { id: jobId, ...args.meta } };
    await tx`
      insert into project_runs (id, org_id, user_id, project_id, kind, status, blocked_reason, job_id, priority, stage,
        total_documents, processed_documents, pages_total, pages_processed, input_cost_cents, output_cost_cents, pipeline, stats,
        creation_ready_at, creation_expires_at)
      -- The documents are inserted in this transaction, so the manifest is complete when it commits; without
      -- creation_ready_at neither runLifecycle.start nor run-start recovery would ever start the run.
      values (${runId}, ${project.orgId}, ${args.userId}, ${project.id}, 'reindex', ${status}, ${batchBlockedReason}, ${jobId}, 0, 'queued',
        ${batch.docs.length}, 0, ${pages}, 0, 0, 0, ${tx.json(JSON.parse(JSON.stringify(batch.pipeline)))}, ${tx.json(JSON.parse(JSON.stringify(stats)))},
        now(), null)
    `;
    for (const doc of batch.docs) {
      const canonicalId = doc.canonical_id ?? `docslurp:document:${doc.id}`;
      if (!doc.canonical_id) await tx`update documents set canonical_id = ${canonicalId} where id = ${doc.id} and canonical_id is null`;
      const versionNumber = await nextVersionNumber(tx as unknown as typeof sql, project.id, canonicalId);
      await tx`
        insert into documents (id, org_id, user_id, project_id, run_id, filename, mime_type, source_key, status,
          extraction_mode, page_count, billing_pages, billing_pages_method, page_count_source, file_facts,
          canonical_id, version_number, previous_version_id, reused_from_document_id,
          source_sha256, source_path, indexing_mode, reindex_of)
        values (${randomUUID()}, ${doc.org_id}, ${doc.user_id}, ${doc.project_id}, ${runId}, ${doc.filename},
          ${doc.mime_type}, ${doc.source_key}, 'queued', ${doc.extraction_mode}, ${doc.page_count},
          ${doc.billing_pages ?? null}, ${doc.billing_pages_method ?? null}, ${doc.page_count_source ?? "assumed"},
          ${doc.file_facts ? tx.json(doc.file_facts as never) : null},
          ${canonicalId}, ${versionNumber}, ${doc.id},
          ${batch.partial ? doc.id : null}, ${doc.source_sha256 ?? null}, ${doc.source_path ?? ""},
          ${effectiveIndexingMode("full")}, ${doc.id})
      `;
    }
    documents += batch.docs.length;
    if (!batchBlockedReason && creditLeasesEnabled() && !spendGuardsSkipped()) {
      try {
        await tx.savepoint(async (sp) => {
          await requireRunCreditLease(sp, { runId, orgId: project.orgId, projectId: project.id });
        });
      } catch (error) {
        // Save the requested configuration and document manifests, but never
        // publish queued work whose mandatory lease was refused or uncertain.
        batchBlockedReason = "credits";
        await tx`update project_runs set status = 'blocked', blocked_reason = 'credits'
          where id = ${runId} and org_id = ${project.orgId} and project_id = ${project.id}`;
        console.warn(`[credit-leases] run=${runId} admission blocked: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (batchBlockedReason) blockedReason ??= batchBlockedReason;
    else queuedRunIds.push(runId);
    runIds.push(runId);
  }
  return { runIds, queuedRunIds, blockedReason, documents };
}

export type ReusableSplit = {
  partial: Array<{ stages: PipelineRunStage[]; docs: ReindexTarget[] }>;
  full: ReindexTarget[];
};

/** Stages a cancelled re-index still owed each source document: its stage subset, or null when it re-ran everything. */
export type StageCarry = Map<string, PipelineRunStage[] | null>;

/** Unfinished documents of the project's in-flight re-index runs, with the stages those runs were building. */
async function loadStageCarry(client: typeof sql | Tx, projectId: string): Promise<StageCarry> {
  const db = client as typeof sql;
  const rows = await db<{ source: string; subset: PipelineRunStage[] | null }[]>`
    select d.previous_version_id as source, r.pipeline -> 'stageSubset' as subset
    from project_runs r
    join documents d on d.run_id = r.id
    where r.project_id = ${projectId} and r.kind = 'reindex' and r.status in ('queued', 'blocked', 'processing')
      and coalesce(r.control_state, '') <> 'cancelled'
      and d.status not in ('completed', 'failed', 'cancelled', 'pii_blocked')
      and d.previous_version_id is not null
  `;
  const carry: StageCarry = new Map();
  for (const row of rows) {
    const subset = Array.isArray(row.subset) && row.subset.length > 0 ? row.subset : null;
    if (!carry.has(row.source)) { carry.set(row.source, subset); continue; }
    const existing = carry.get(row.source);
    carry.set(row.source, existing === null || subset === null ? null : [...new Set([...existing!, ...subset])]);
  }
  return carry;
}

/** The change's stages plus whatever a cancelled run still owed the document, in pipeline order; null = re-run everything. */
function stagesFor(docId: string, base: readonly PipelineRunStage[], carry: StageCarry): PipelineRunStage[] | null {
  if (!carry.has(docId)) return [...base];
  const owed = carry.get(docId);
  if (owed === null || owed === undefined) return null;
  const union = new Set<PipelineRunStage>([...base, ...owed]);
  // Dataflow consumers of the union are added when the run's stage subset is compiled.
  return pipelineStageOrder.filter((stage) => union.has(stage));
}

/**
 * Splits documents into those a partial re-index can seed from their source run (grouped by the stages they
 * owe) and those that must re-run in full (source artifacts purged, or a cancelled run owed everything).
 */
async function splitReusable(
  targets: ReindexTarget[],
  pipeline: PipelineFeatures,
  base: readonly PipelineRunStage[],
  carry: StageCarry,
): Promise<ReusableSplit> {
  const full: ReindexTarget[] = [];
  const bySet = new Map<string, { stages: PipelineRunStage[]; docs: ReindexTarget[] }>();
  for (const doc of targets) {
    const stages = stagesFor(doc.id, base, carry);
    if (!stages) { full.push(doc); continue; }
    const key = stages.join(",");
    const group = bySet.get(key) ?? { stages, docs: [] };
    group.docs.push(doc);
    bySet.set(key, group);
  }
  const partial: ReusableSplit["partial"] = [];
  for (const group of bySet.values()) {
    const byRun = new Map<string, ReindexTarget[]>();
    for (const doc of group.docs) byRun.set(doc.run_id, [...(byRun.get(doc.run_id) ?? []), doc]);
    const ok: ReindexTarget[] = [];
    for (const [runId, docs] of byRun) {
      try {
        await assertBackfillReusableMany(
          [{ runId, documentIds: docs.map((doc) => doc.id) }],
          { ...pipeline, stageSubset: [...group.stages] } as PipelineFeatures,
        );
        ok.push(...docs);
      } catch (error) {
        if (!isReprocessRejectedError(error)) throw error;
        full.push(...docs);
      }
    }
    if (ok.length > 0) partial.push({ stages: group.stages, docs: ok });
  }
  return { partial, full };
}

export type AppliedProjectChange = {
  project: ProjectRecord;
  plan: ProjectChangePlan;
  job: JobStatus | null;
  /** Runs that were inserted `queued` and need their workflow started. */
  queuedRunIds: string[];
  /** In-flight re-index runs of an older index config that this change cancelled. */
  cancelledRunIds: string[];
};

/**
 * Cancels the project's in-flight re-index runs (they build an index config that is no longer wanted):
 * queued and blocked runs fail at once, processing runs are asked to cancel (signalled after commit). Their
 * unfinished documents are cancelled so the source versions are free to be re-queued. Returns the processing
 * run ids that still need the cancel signal.
 */
async function cancelInFlightReindexRuns(tx: Tx, projectId: string): Promise<{ all: string[]; processing: string[] }> {
  const rows = await tx<{ id: string; was: string }[]>`
    with before as (
      select id, status as was from project_runs
      where project_id = ${projectId} and kind = 'reindex' and status in ('queued', 'blocked', 'processing')
        and coalesce(control_state, '') <> 'cancelled'
      for update
    )
    update project_runs r
    set status = case when before.was = 'processing' then r.status else 'failed' end,
        control_state = case when before.was = 'processing' then 'cancel_requested' else 'cancelled' end,
        control_requested_at = now(),
        blocked_reason = null,
        error = case when before.was = 'processing' then r.error else 'Superseded by a newer index configuration' end,
        lease_expires_at = case when before.was = 'processing' then r.lease_expires_at else now() end,
        updated_at = now()
    from before
    where r.id = before.id
    returning r.id, before.was
  `;
  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await tx`
      update documents set status = 'cancelled', updated_at = now()
      where run_id = any(${ids}) and status not in ('completed', 'failed', 'cancelled', 'pii_blocked')
    `;
  }
  return { all: ids, processing: rows.filter((row) => row.was === "processing").map((row) => row.id) };
}

/**
 * Saves the config and, when the plan re-indexes or changes the index config of existing documents, records
 * `index_configs` and inserts the re-index runs, all in one transaction under a per-project lock. A newer
 * required change first cancels the older in-flight re-index runs and queues every document not yet on the new
 * index. Admission failure never rolls the config back: the runs are inserted `blocked` with the reason.
 */
export async function applyProjectChange(args: {
  plan: ProjectChangePlan;
  userId: string;
  updateOptions?: Omit<ProjectUpdateOptions, "client">;
  env?: EstimateEnv;
  /** Plan-and-apply attempts before giving up with a retryable conflict (default 5). */
  maxAttempts?: number;
  /** Trusted approval callers recheck authorization while holding the config lock. */
  authorize?: (client: typeof sql) => Promise<void>;
  afterSave?: (client: typeof sql) => Promise<void>;
  expectedTargetSignature?: string;
}): Promise<AppliedProjectChange | null> {
  let plan = args.plan;
  for (let attempt = 0; attempt < (args.maxAttempts ?? MAX_REPLANS); attempt += 1) {
    const applied = await applyPlannedChange({ ...args, plan });
    if (applied !== STALE_PLAN) return applied;
    if (attempt + 1 >= (args.maxAttempts ?? MAX_REPLANS)) break;
    // A concurrent change was saved after planning: plan again from what is stored now, so neither change is lost.
    const replanned = await planProjectChange({
      projectId: plan.project.id, userId: args.userId, input: plan.input, indexingMode: args.updateOptions?.indexingMode, env: args.env,
    });
    if (!replanned) return null;
    plan = replanned;
  }
  throw new ConfigConflictError();
}

async function applyPlannedChange(args: {
  plan: ProjectChangePlan;
  userId: string;
  updateOptions?: Omit<ProjectUpdateOptions, "client">;
  env?: EstimateEnv;
  authorize?: (client: typeof sql) => Promise<void>;
  afterSave?: (client: typeof sql) => Promise<void>;
  expectedTargetSignature?: string;
}): Promise<AppliedProjectChange | null | typeof STALE_PLAN> {
  const { plan, userId } = args;
  const { project } = plan;
  // Mode-switch validation reads on other connections, so it runs before any transaction opens.
  if (deferredProfilesEnabled() && (plan.nextPipeline.indexingMode !== project.pipeline.indexingMode || (plan.nextPipeline.indexingMode === "visual" && plan.nextPipeline.quality === "fast"))) {
    await validateModeSwitch({ current: project, nextPipeline: plan.nextPipeline });
  }
  const lock = (tx: Tx) => tx`select pg_advisory_xact_lock(hashtextextended(${`config-change:${project.id}`}, 0))`;
  if (!plan.willReindex && !plan.recordsIndexChange) {
    const editAccess = await getProjectAccess(project.id, userId);
    if (!editAccess || !canEditProject(editAccess, userId)) return null;
    const saved = await sql.begin(async (tx) => {
      await lock(tx);
      if (await projectRowVersion(tx, project.id) !== plan.rowVersion) return STALE_PLAN;
      await args.authorize?.(tx as unknown as typeof sql);
      const updated = await updateProject(project.id, userId, plan.input, {
        ...args.updateOptions,
        client: tx as unknown as typeof sql,
        precomputed: { current: project, pipeline: plan.nextPipeline },
      });
      if (updated) await args.afterSave?.(tx as unknown as typeof sql);
      return updated;
    });
    if (saved === STALE_PLAN) return STALE_PLAN;
    if (!saved) return null;
    const updated = await getProject(project.id, userId);
    return updated ? { project: updated, plan, job: null, queuedRunIds: [], cancelledRunIds: [] } : null;
  }

  // Budget caps are checked before the transaction (they read the month's spend); a block saves the change
  // and parks the job, exactly like a credit block inside it.
  let blockedReason: "credits" | "budget" | "policy" | null = null;
  if (plan.willReindex) {
    try {
      await enforceLiveBudgetCaps(project.id, project.orgId);
    } catch (error) {
      if (!isSpendBlockedError(error)) throw error;
      blockedReason = spendBlockJobReason(error.code);
    }
  }

  const jobMeta: Omit<JobMeta, "id"> = {
    kind: "reindex",
    // The same estimate the estimate route returns (null when the change creates no work).
    estimate: plan.estimate,
    estimateUrl: `/v1/projects/${project.id}/estimate`,
  };

  // Everything that reads on other connections happens before the transaction opens.
  const access = await getProjectAccess(project.id, userId);
  if (!access || !canEditProject(access, userId)) return null;
  const supersedesInFlight = plan.willReindex && plan.reindex === "required" && plan.hashChanged;
  // A newer index change cancels older re-index runs: their documents owe those runs' stages as well.
  const plannedCarry: StageCarry = supersedesInFlight ? await loadStageCarry(sql, project.id) : new Map();
  const reusable: ReusableSplit = plan.willReindex
    ? await splitReusable(plan.targets, plan.nextPipeline, plan.impact.stages, plannedCarry)
    : { partial: [], full: [] };
  const reusableIds = new Set(reusable.partial.flatMap((group) => group.docs.map((doc) => doc.id)));
  const afterHash = indexConfigHash(plan.afterConfig);
  const beforeHash = indexConfigHash(plan.beforeConfig);

  const result = await sql.begin(async (tx) => {
    await lock(tx);
    if (await projectRowVersion(tx, project.id) !== plan.rowVersion) return STALE_PLAN;
    await args.authorize?.(tx as unknown as typeof sql);
    if (args.expectedTargetSignature !== undefined) {
      const approvedTargets = await loadTargets(tx, project.id, {
        hashNot: plan.reindex === "required" && plan.hashChanged ? afterHash : null, ignoreReindexRuns: supersedesInFlight,
      });
      if (reindexTargetSignature(approvedTargets) !== args.expectedTargetSignature) throw new ConfigConflictError();
    }
    const carry: StageCarry = supersedesInFlight ? await loadStageCarry(tx, project.id) : new Map();
    const cancelled = supersedesInFlight ? await cancelInFlightReindexRuns(tx, project.id) : { all: [], processing: [] };
    const saved = await updateProject(project.id, userId, plan.input, {
      ...args.updateOptions,
      client: tx as unknown as typeof sql,
      precomputed: { current: project, pipeline: plan.nextPipeline },
    });
    if (!saved) return null;
    await args.afterSave?.(tx as unknown as typeof sql);
    if (plan.recordsIndexChange) {
      // Documents indexed before hashes were recorded belong to the config that was current until now.
      await tx`
        update documents d set index_config_hash = ${beforeHash}
        where d.project_id = ${project.id} and d.index_config_hash is null and ${LIVE_DOCUMENT}
          and (d.indexing_mode is null or d.indexing_mode = 'full')
          and exists (select 1 from vector_indexes v where v.document_id = d.id)
      `;
      // Native search caches each document's owner index config hash.
      await notifySearchEligibilityChanged(tx as unknown as typeof sql, [project.id]);
      await tx`
        update projects
        set index_configs = jsonb_build_object(${beforeHash}::text, ${tx.json(JSON.parse(JSON.stringify(plan.beforeConfig)))}::jsonb)
          || coalesce(index_configs, '{}'::jsonb)
          || jsonb_build_object(${afterHash}::text, ${tx.json(JSON.parse(JSON.stringify(plan.afterConfig)))}::jsonb)
        where id = ${project.id}
      `;
    }
    if (!plan.willReindex) return { runs: null as ReindexRunResult | null, cancelled };
    // Re-read the targets under the lock: another PATCH or upload may have changed them since planning.
    const targets = await loadTargets(tx, project.id, {
      hashNot: plan.reindex === "required" && plan.hashChanged ? afterHash : null,
      ignoreReindexRuns: supersedesInFlight,
    });
    if (args.expectedTargetSignature !== undefined && reindexTargetSignature(targets) !== args.expectedTargetSignature) throw new ConfigConflictError();
    if (targets.length === 0) return { runs: null as ReindexRunResult | null, cancelled };
    // Documents that appeared since planning re-run in full (their reusability was not checked).
    const split: ReusableSplit = { partial: [], full: [] };
    const planned = new Map<string, { stages: PipelineRunStage[]; docs: ReindexTarget[] }>();
    for (const doc of targets) {
      const stages = stagesFor(doc.id, plan.impact.stages, carry);
      if (!stages || !reusableIds.has(doc.id)) { split.full.push(doc); continue; }
      const group = planned.get(stages.join(",")) ?? { stages, docs: [] };
      group.docs.push(doc);
      planned.set(stages.join(","), group);
    }
    split.partial = [...planned.values()];
    const runs = await createReindexRuns({
      tx, project, pipeline: { ...plan.nextPipeline, speedBoost: plan.input.speedBoost === true }, userId,
      meta: jobMeta, blockedReason, reusable: split,
    });
    return { runs, cancelled };
  });
  if (result === STALE_PLAN) return STALE_PLAN;
  if (!result) return null;
  for (const runId of result.cancelled.processing) {
    await signalPipelineCancel(runId).catch((error: unknown) => {
      console.warn(`[config-change] run=${runId} cancel signal failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  const updated = await getProject(project.id, userId);
  if (!updated) return null;
  if (!result.runs) return { project: updated, plan, job: null, queuedRunIds: [], cancelledRunIds: result.cancelled.all };
  const job = await jobStatusForMutation(
    { id: result.runs.runIds[0]!, kind: "reindex", estimate: jobMeta.estimate ?? null, ...(jobMeta.estimateUrl ? { estimateUrl: jobMeta.estimateUrl } : {}) },
    result.runs.runIds,
    userId,
  );
  return { project: updated, plan, job, queuedRunIds: result.runs.queuedRunIds, cancelledRunIds: result.cancelled.all };
}

/** What `POST /v1/projects/:id/estimate` returns. */
export type ProjectEstimateResponse = {
  impact: ConfigChangeImpact;
  estimate: CostEstimate | null;
  /** The project's documents under the new configuration, in the `POST /v1/estimate` shape (ingest = this change's work). */
  quote: import("@docslurp/shared").EstimateQuote | null;
  billing: "enforced" | "disabled";
};

/** The estimate of a change that reprocesses nothing. */
function noWork(billing: "enforced" | "disabled"): CostEstimate {
  return { pages: 0, documents: 0, billing, credits: billing === "enforced" ? { low: 0, high: 0 } : null, seconds: { low: 0, high: 0 }, basis: "No documents are reprocessed by this change." };
}

export function billingState(env: EstimateEnv = process.env): "enforced" | "disabled" {
  return isBillingEnforced(env) ? "enforced" : "disabled";
}

export async function estimateProjectChange(args: {
  projectId: string;
  userId: string;
  input: UpdateProjectInput;
  env?: EstimateEnv;
}): Promise<ProjectEstimateResponse | null> {
  const plan = await planProjectChange(args);
  if (!plan) return null;
  // The same quote shape as POST /v1/estimate: the project's measured documents under the new configuration.
  const { quoteStoredDocuments } = await import("./stored-quote.js");
  const quote = plan.project.orgId
    ? await quoteStoredDocuments({ scope: { orgId: plan.project.orgId, projectId: plan.project.id }, pipeline: plan.nextPipeline, estimate: plan.estimate ?? noWork(billingState(args.env)), env: args.env })
    : null;
  return { impact: plan.impact, estimate: plan.estimate, quote, billing: billingState(args.env) };
}

/** Whether the caller may change the project at all (used before planning writes). */
export async function canChangeProject(projectId: string, userId: string): Promise<boolean> {
  const access = await getProjectAccess(projectId, userId);
  return Boolean(access && canEditProject(access, userId));
}

export { recordJobMeta };

/** Frozen approval work identity; ignores index hashes which this transaction intentionally stamps. */
export function reindexTargetSignature(targets: readonly ReindexTarget[]): string {
  return JSON.stringify(targets.map(d => [d.id, d.page_count, d.run_id, d.source_key, d.source_sha256]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
}
