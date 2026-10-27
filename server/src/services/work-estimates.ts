import {
  compilePipelinePlan,
  effectiveIndexingMode,
  estimateUploadMedia,
  uploadMediaKind,
  type UploadMediaEstimate,
  type UploadMediaFile,
  withoutStageSelection,
  type CostEstimate,
  type PipelineFeatures,
  type ReprocessRunInput,
} from "@docslurp/shared";

import { sql } from "../db.js";
import { estimateWork, sumEstimates, type EstimateEnv } from "./config-change.js";
import { getRun } from "./runs.js";
import { listEditableWorkspaceIds } from "./organizations.js";

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
 * workspace and pipeline exactly like the mutation, and the group estimates are summed. `workspaceId`
 * restricts the selection (the workspace-scoped estimate route).
 */
export async function estimateDocumentReprocess(args: {
  documentIds: string[];
  userId: string;
  workspaceId?: string;
  env?: EstimateEnv;
}): Promise<CostEstimate | null> {
  const workspaceIds = await listEditableWorkspaceIds(args.userId);
  if (workspaceIds.length === 0 || args.documentIds.length === 0) return null;
  const rows = await sql<{ workspace_id: string; org_id: string; page_count: number; indexing_mode: string | null; pipeline: PipelineFeatures | null }[]>`
    select d.workspace_id, d.org_id, d.page_count, d.indexing_mode,
      (select wr.pipeline from workspace_runs wr where wr.id = d.run_id) as pipeline
    from documents d
    where d.workspace_id = any(${sql.array(workspaceIds)}) and d.id = any(${sql.array(args.documentIds)})
      ${args.workspaceId ? sql`and d.workspace_id = ${args.workspaceId}` : sql``}
  `;
  const groups = new Map<string, { orgId: string; features: PipelineFeatures; documents: number; pages: number }>();
  for (const row of rows) {
    const base = (row.pipeline ?? {}) as PipelineFeatures;
    const features = row.indexing_mode ? { ...base, indexingMode: effectiveIndexingMode(row.indexing_mode as PipelineFeatures["indexingMode"]) } : base;
    const key = `${row.workspace_id}:${JSON.stringify(features)}`;
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

/** Pages assumed for a file whose page count the client does not know (about 75 KB of source per page). */
export const ASSUMED_BYTES_PER_PAGE = 75 * 1024;

/**
 * `POST /v1/uploads/estimate`: ingesting new files with the target workspace's pipeline. Audio and video are priced
 * by duration (`media`, also included in `estimate.credits`); everything else by page.
 */
export async function estimateUpload(args: {
  files: Array<UploadMediaFile & { pages?: number }>;
  workspace: { pipeline: PipelineFeatures; orgId: string };
  env?: EstimateEnv;
}): Promise<{ estimate: CostEstimate; media: UploadMediaEstimate | null }> {
  const paged = args.files.filter((file) => !uploadMediaKind(file));
  const pages = paged.reduce(
    (sum, file) => sum + Math.max(1, Math.round(file.pages ?? Math.ceil(file.size / ASSUMED_BYTES_PER_PAGE))),
    0,
  );
  const media = estimateUploadMedia(args.files, { videoFrames: args.workspace.pipeline.mediaVideo?.enabled !== false });
  const documents = estimateWork({
    features: args.workspace.pipeline,
    stages: compilePipelinePlan(args.workspace.pipeline).stageOrder,
    documents: paged.length,
    pages,
    orgId: args.workspace.orgId,
    env: args.env,
  });
  const estimate = await documents;
  if (!media) return { estimate, media };
  // Media files add their own price; the page estimate already covers any other files in the batch.
  return {
    media,
    estimate: {
      ...estimate,
      documents: estimate.documents + media.audioFiles + media.videoFiles,
      credits: estimate.credits
        ? { low: estimate.credits.low + media.credits.low, high: estimate.credits.high + media.credits.high }
        : null,
      basis: `${estimate.basis}; audio and video priced by duration`,
    },
  };
}

/** The one workspace the (editable) documents belong to, or null when they span several or none are found. */
export async function singleWorkspaceOf(documentIds: string[], userId: string): Promise<string | null> {
  const workspaceIds = await listEditableWorkspaceIds(userId);
  if (workspaceIds.length === 0 || documentIds.length === 0) return null;
  const rows = await sql<{ workspace_id: string }[]>`
    select distinct workspace_id from documents
    where workspace_id = any(${sql.array(workspaceIds)}) and id = any(${sql.array(documentIds)})
  `;
  return rows.length === 1 ? rows[0]!.workspace_id : null;
}

export { sumEstimates };
