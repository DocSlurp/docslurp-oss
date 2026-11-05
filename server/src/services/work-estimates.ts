import {
  compilePipelinePlan,
  effectiveIndexingMode,
  estimateProfileFor,
  quoteUpload,
  type EstimateProfile,
  type QuoteFile,
  type UploadMediaEstimate,
  sanitizeStoredPipeline,
  withoutStageSelection,
  type CostEstimate,
  type PipelineFeatures,
  type ReprocessRunInput,
} from "@docslurp/shared";

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
    ...(args.options?.stages?.length ? { stageSubset: [...args.options.stages] } : {}),
    ...(args.options?.stageFrom && !args.options?.stages?.length ? { restartFromStage: args.options.stageFrom } : {}),
  };
  // Price the selected stages against the run's full plan.
  return await estimateWork({
    features: withoutStageSelection(features),
    stages: compilePipelinePlan(features).stageOrder,
    documents: run.totalDocuments,
    pages: run.pagesTotal,
    orgId: run.orgId,
    env: args.env,
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
  const rows = await sql<{ project_id: string; org_id: string; page_count: number; indexing_mode: string | null; pipeline: PipelineFeatures | null }[]>`
    select d.project_id, d.org_id, d.page_count, d.indexing_mode,
      (select wr.pipeline from project_runs wr where wr.id = d.run_id) as pipeline
    from documents d
    where d.project_id = any(${sql.array(projectIds)}) and d.id = any(${sql.array(args.documentIds)})
      ${args.projectId ? sql`and d.project_id = ${args.projectId}` : sql``}
  `;
  const groups = new Map<string, { orgId: string; features: PipelineFeatures; documents: number; pages: number }>();
  for (const row of rows) {
    // Same lenient read as the mutation: drop stored extractor settings the strict schemas now reject.
    const base = sanitizeStoredPipeline((row.pipeline ?? {}) as PipelineFeatures, `a run in project ${row.project_id}`);
    base.speedBoost = args.speedBoost === true;
    const features = row.indexing_mode ? { ...base, indexingMode: effectiveIndexingMode(row.indexing_mode as PipelineFeatures["indexingMode"]) } : base;
    const key = `${row.project_id}:${JSON.stringify(features)}`;
    const group = groups.get(key) ?? { orgId: row.org_id, features, documents: 0, pages: 0 };
    group.documents += 1;
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
  env?: EstimateEnv;
}): Promise<{ estimate: CostEstimate; media: UploadMediaEstimate | null; profile: EstimateProfile }> {
  const profile = estimateProfileFor(args.project.pipeline, {
    workerSlots: await orgWorkerSlots(args.project.orgId),
    env: args.env ?? process.env,
  });
  return { ...quoteUpload({ files: args.files, profile, speedBoost: args.speedBoost === true }), profile };
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
