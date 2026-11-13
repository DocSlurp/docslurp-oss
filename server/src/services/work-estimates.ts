import {
  chartExportConfigOf,
  compilePipelinePlan,
  effectiveIndexingMode,
  estimateProfileFor,
  quoteEstimate,
  quoteSettingsForPipeline,
  quoteUpload,
  type EstimateQuote,
  type EstimateRequest,
  type QuoteSettings,
  type EstimateProfile,
  type QuoteFile,
  type UploadMediaEstimate,
  sanitizeStoredPipeline,
  withoutStageSelection,
  type CostEstimate,
  type PipelineFeatures,
  type ReprocessRunInput,
} from "@docslurp/shared";

import { estimateChartExportCredits, resolveChartExportTier, type ChartExportTier, type RunOrigin } from "@docslurp/shared";
import { sql } from "../db.js";
import { estimateWork, orgWorkerSlots, sumEstimates, type EstimateEnv } from "./config-change.js";
import { getRun } from "./runs.js";
import { listEditableProjectIds } from "./organizations.js";

/** Estimates for work-creating routes other than config changes. Each is shared by the mutation and its `/estimate` twin. */

/** `POST /v1/runs/:id/reprocess`: the stages the request would run again over the run's documents. */
export async function estimateRunReprocess(args: {
  runId: string;
  userId: string;
  options?: ReprocessRunInput;
  env?: EstimateEnv;
}): Promise<CostEstimate | null> {
  const run = await getRun(args.runId, args.userId);
  if (!run) return null;
  const features: PipelineFeatures = {
    ...(JSON.parse(JSON.stringify(withoutStageSelection(run.pipeline))) as PipelineFeatures),
    speedBoost: args.options?.speedBoost === true,
    // A per-request tier wins over the tier the run resolved; only `models` is priced.
    ...(args.options?.chartExport ? { chartExport: { ...(run.pipeline.chartExport ?? {}), tier: args.options.chartExport.tier } } : {}),
    ...(args.options?.stages?.length ? { stageSubset: [...args.options.stages] } : {}),
    ...(args.options?.stageFrom && !args.options?.stages?.length ? { restartFromStage: args.options.stageFrom } : {}),
  };
  // Price the selected stages against the run's full plan.
  const stages = compilePipelinePlan(features).stageOrder;
  const documentIds = run.projectId && chartExportConfigOf(features)
    ? (await sql<{ id: string }[]>`select id from documents where run_id = ${run.id} and org_id = ${run.orgId} and project_id = ${run.projectId}`).map((row) => row.id)
    : [];
  return await estimateWork({
    features: withoutStageSelection(features),
    stages,
    documents: run.totalDocuments,
    pages: run.pagesTotal,
    orgId: run.orgId,
    env: args.env,
    ...(run.projectId && documentIds.length ? { visualScope: { projectId: run.projectId, documentIds } } : {}),
  });
}

/**
 * Bulk document reprocess: every selected document re-runs its run's pipeline. Documents are grouped by
 * project and pipeline exactly like the mutation, and the group estimates are summed. `projectId`
 * restricts the selection (the project-scoped estimate route).
 */
export async function estimateDocumentReprocess(args: {
  speedBoost?: boolean;
  documentIds: string[];
  userId: string;
  projectId?: string;
  env?: EstimateEnv;
}): Promise<CostEstimate | null> {
  const projectIds = await listEditableProjectIds(args.userId);
  if (projectIds.length === 0 || args.documentIds.length === 0) return null;
  const rows = await sql<{ id: string; project_id: string; org_id: string; page_count: number; indexing_mode: string | null; pipeline: PipelineFeatures | null }[]>`
    select d.id, d.project_id, d.org_id, d.page_count, d.indexing_mode,
      (select wr.pipeline from project_runs wr where wr.id = d.run_id) as pipeline
    from documents d
    where d.project_id = any(${sql.array(projectIds)}) and d.id = any(${sql.array(args.documentIds)})
      ${args.projectId ? sql`and d.project_id = ${args.projectId}` : sql``}
  `;
  const groups = new Map<string, { orgId: string; projectId: string; features: PipelineFeatures; documents: number; pages: number; documentIds: string[] }>();
  for (const row of rows) {
    // Same lenient read as the mutation: drop stored extractor settings the strict schemas now reject.
    const base = sanitizeStoredPipeline((row.pipeline ?? {}) as PipelineFeatures, `a run in project ${row.project_id}`);
    base.speedBoost = args.speedBoost === true;
    const features = row.indexing_mode ? { ...base, indexingMode: effectiveIndexingMode(row.indexing_mode as PipelineFeatures["indexingMode"]) } : base;
    const key = `${row.project_id}:${JSON.stringify(features)}`;
    const group = groups.get(key) ?? { orgId: row.org_id, projectId: row.project_id, features, documents: 0, pages: 0, documentIds: [] };
    group.documents += 1;
    group.documentIds.push(row.id);
    group.pages += Math.max(0, row.page_count ?? 0);
    groups.set(key, group);
  }
  const parts: CostEstimate[] = [];
  for (const group of groups.values()) {
    parts.push(await estimateWork({
      features: group.features,
      stages: compilePipelinePlan(group.features).stageOrder,
      documents: group.documents,
      pages: group.pages,
      orgId: group.orgId,
      env: args.env,
      visualScope: { projectId: group.projectId, documentIds: group.documentIds },
    }));
  }
  return sumEstimates(parts);
}

/**
 * `POST /v1/uploads/estimate`: ingesting new files with the target project's pipeline. Audio and video are priced
 * by duration (`media`, also included in `estimate.credits`); everything else by page. The project reduces to an
 * EstimateProfile, which the response returns so offline estimators (`@docslurp/estimate`) price later batches the same way.
 */
export async function estimateUpload(args: {
  speedBoost?: boolean;
  files: QuoteFile[];
  project: { pipeline: PipelineFeatures; orgId: string };
  settings?: Partial<QuoteSettings>;
  env?: EstimateEnv;
  /** Per-request chart export tier (wins over the project's); null or unset uses the project's tier or the origin default. */
  chartExportTier?: ChartExportTier | null;
  origin?: RunOrigin;
}): Promise<{ estimate: CostEstimate; media: UploadMediaEstimate | null; profile: EstimateProfile; quote: EstimateQuote; chartExport: { tier: ChartExportTier; source: "request" | "project" | "default"; credits: { low: number; high: number } | null } }> {
  const workerSlots = await orgWorkerSlots(args.project.orgId);
  const env = args.env ?? process.env;
  const profile = estimateProfileFor(args.project.pipeline, { workerSlots, env });
  // The same quote function as the public estimate, from the project's settings; the explicit speed boost wins.
  const quote = quoteEstimate(
    { files: args.files.map((file) => ({ ...file, ...(file.type === null ? { type: undefined } : {}) })) as EstimateRequest["files"], settings: { ...args.settings, speedBoost: args.speedBoost === true } },
    { base: quoteSettingsForPipeline(args.project.pipeline), workerSlots, env },
  );
  const upload = quoteUpload({ files: args.files, profile, speedBoost: args.speedBoost === true });
  // Chart export: the tier this upload would resolve to for the caller's surface; only `models` adds credits.
  const tier = resolveChartExportTier({ requested: args.chartExportTier, project: args.project.pipeline.chartExport, origin: args.origin ?? "machine", env });
  const source = args.chartExportTier ? "request" : args.project.pipeline.chartExport?.tier ? "project" : "default";
  const charts = estimateChartExportCredits({ features: args.project.pipeline, tier, pages: upload.estimate.pages, documents: Math.max(1, args.files.length), env });
  const estimate = upload.estimate.credits && (charts.low > 0 || charts.high > 0)
    ? { ...upload.estimate, credits: { low: upload.estimate.credits.low + charts.low, high: upload.estimate.credits.high + charts.high }, basis: `${upload.estimate.basis}${charts.note ?? ""}` }
    : upload.estimate;
  return {
    ...upload, estimate, profile, quote,
    chartExport: { tier, source, credits: upload.estimate.credits ? { low: charts.low, high: charts.high } : null },
  };
}

/** The one project the (editable) documents belong to, or null when they span several or none are found. */
export async function singleProjectOf(documentIds: string[], userId: string): Promise<string | null> {
  const projectIds = await listEditableProjectIds(userId);
  if (projectIds.length === 0 || documentIds.length === 0) return null;
  const rows = await sql<{ project_id: string }[]>`
    select distinct project_id from documents
    where project_id = any(${sql.array(projectIds)}) and id = any(${sql.array(documentIds)})
  `;
  return rows.length === 1 ? rows[0]!.project_id : null;
}

export { sumEstimates };
