import {
  EDITOR_REQUIRED_CODE,
  EDITOR_REQUIRED_MESSAGE,
  effectiveSummaryTreeSearchMode,
  normalizePipelineFeatures,
  SUMMARY_TREE_BUILD_ENV_FLAG,
  SUMMARY_TREE_BUILD_STALE_MS,
  SUMMARY_TREE_BUILD_UNAVAILABLE_CODE,
  SUMMARY_TREE_CONSTANTS,
  SUMMARY_TREE_REQUIRES_VECTORS_CODE,
  SUMMARY_TREE_REQUIRES_VECTORS_MESSAGE,
  summaryTreeBuildAvailable,
  summaryTreeBuildStatus,
  SummaryTreeConfigError,
  summaryTreeEnabled,
  summaryTreeSearchModeSchema,
  summaryTreeServeAvailable,
  summaryTreeVectorProblem,
  type PipelineFeatures,
  type ProjectSummaryTreeState,
  type SummaryTreeSearchMode,
  type UpdateProjectSummaryTreeInput,
} from "@docslurp/shared";

import { sql, type SqlClient } from "../db.js";
import { canEditProject, getProjectAccess } from "./organizations.js";
import { getProject, updateProject } from "./projects.js";

/**
 * Project summary tree: the setting, the deployment switches and the build state (packages/shared summary-tree.ts).
 *
 * `updateProjectSummaryTree` is the only writer of `pipeline.summaryTree`. Every other project update keeps the stored
 * value (services/projects.ts), so no template, default, upload override, chat proposal or settings-form save can
 * turn the tree on. Saving the setting never queues a build: new uploads get a tree, existing documents only from the
 * tree's own job.
 */

type Env = Readonly<Record<string, string | undefined>>;

export const SUMMARY_TREE_UNAVAILABLE_MESSAGE = "The summary tree is not available on this deployment.";

export class ProjectSummaryTreeError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409, readonly code?: string) {
    super(message);
    this.name = "ProjectSummaryTreeError";
  }
}

type TreeCountsRow = {
  total: number;
  ready: number;
  building: number;
  partial: number;
  skipped: number;
  nodes: number;
  search_mode: string | null;
};

/**
 * The `summaryTree` block of the project state. Counts cover the project's current documents only (completed, not
 * superseded). A document left `building` by a worker that died (no heartbeat for `SUMMARY_TREE_BUILD_STALE_MS`)
 * counts as partial: nothing is building it, and the backfill job picks it up. Caller must establish project access first; every query is scoped to `projectId` and `orgId`.
 */
export async function getProjectSummaryTreeState(
  args: { projectId: string; orgId: string; pipeline?: PipelineFeatures | null },
  client: SqlClient = sql,
  env: Env = process.env,
): Promise<ProjectSummaryTreeState> {
  const [row] = await client<TreeCountsRow[]>`
    with docs as (
      select d.id from documents d
      where d.project_id = ${args.projectId} and d.org_id = ${args.orgId}
        and d.status = 'completed' and d.superseded_at is null and d.purged_at is null
    ),
    trees as (
      -- A building row whose build stopped reporting was left by a dead worker: it is not being built.
      select t.document_id,
        case when t.status = 'building' and t.updated_at <= now() - ${`${SUMMARY_TREE_BUILD_STALE_MS} milliseconds`}::interval then 'abandoned' else t.status end as status
      from document_summary_trees t
      join docs on docs.id = t.document_id
      where t.project_id = ${args.projectId} and t.org_id = ${args.orgId}
    )
    select
      (select count(*)::int from docs) as total,
      (select count(*)::int from trees where status = 'ready') as ready,
      (select count(*)::int from trees where status in ('pending', 'building')) as building,
      (select count(*)::int from trees where status in ('partial', 'abandoned')) as partial,
      (select count(*)::int from trees where status = 'skipped') as skipped,
      (select count(*)::int from document_summary_tree_nodes n
        join docs on docs.id = n.document_id
        where n.project_id = ${args.projectId} and n.org_id = ${args.orgId} and n.status = 'ready') as nodes,
      (select s.compat_metadata #>> '{projectUi,retrievalDefaults,summaryTree}'
        from project_search_settings s where s.project_id = ${args.projectId} limit 1) as search_mode
  `;
  let pipeline = args.pipeline ?? null;
  if (!pipeline) {
    const [project] = await client<{ pipeline: unknown }[]>`
      select pipeline from projects where id = ${args.projectId} and org_id = ${args.orgId}
    `;
    pipeline = project ? normalizePipelineFeatures(project.pipeline as PipelineFeatures) : null;
  }
  const enabled = summaryTreeEnabled(pipeline);
  const total = row?.total ?? 0;
  const counts = {
    total,
    ready: row?.ready ?? 0,
    building: row?.building ?? 0,
    partial: row?.partial ?? 0,
    skipped: row?.skipped ?? 0,
    missing: 0,
  };
  counts.missing = Math.max(0, total - counts.ready - counts.building - counts.partial - counts.skipped);
  const stored = summaryTreeSearchModeSchema.safeParse(row?.search_mode ?? "off");
  const searchMode: SummaryTreeSearchMode = stored.success ? stored.data : "off";
  return {
    enabled,
    buildAvailable: summaryTreeBuildAvailable(env),
    serveAvailable: summaryTreeServeAvailable(env),
    searchMode,
    effectiveSearchMode: effectiveSummaryTreeSearchMode({ pipeline, projectDefault: searchMode, env }),
    status: summaryTreeBuildStatus(enabled, counts),
    documents: counts,
    nodes: row?.nodes ?? 0,
    constants: SUMMARY_TREE_CONSTANTS,
  };
}

async function requireProject(projectRef: string, userId: string, write: boolean) {
  const project = await getProject(projectRef, userId);
  if (!project) throw new ProjectSummaryTreeError("Project not found", 404);
  if (write) {
    const access = await getProjectAccess(project.id, userId);
    if (!access || !canEditProject(access, userId)) throw new ProjectSummaryTreeError(EDITOR_REQUIRED_MESSAGE, 403, EDITOR_REQUIRED_CODE);
  }
  return project;
}

export async function getProjectSummaryTree(projectRef: string, userId: string, env: Env = process.env): Promise<ProjectSummaryTreeState> {
  const project = await requireProject(projectRef, userId, false);
  return await getProjectSummaryTreeState({ projectId: project.id, orgId: project.orgId, pipeline: normalizePipelineFeatures(project.pipeline) }, sql, env);
}

/**
 * Turns the project's summary tree on or off. Turning it on is refused while the deployment's build switch is off
 * (nothing would ever build), without embeddings and the vector index, and under a template that keeps document
 * summaries off. Turning it off is always allowed. Nothing is queued either way.
 */
export async function updateProjectSummaryTree(
  projectRef: string,
  userId: string,
  input: UpdateProjectSummaryTreeInput,
  env: Env = process.env,
): Promise<ProjectSummaryTreeState> {
  const project = await requireProject(projectRef, userId, true);
  const pipeline = normalizePipelineFeatures(project.pipeline);
  if (input.enabled) {
    if (!summaryTreeBuildAvailable(env)) {
      console.warn(`[summary-tree] refused to enable project=${project.id}: ${SUMMARY_TREE_BUILD_ENV_FLAG} is off`);
      throw new ProjectSummaryTreeError(SUMMARY_TREE_UNAVAILABLE_MESSAGE, 400, SUMMARY_TREE_BUILD_UNAVAILABLE_CODE);
    }
    if (summaryTreeVectorProblem({ ...pipeline, summaryTree: { enabled: true } })) {
      throw new ProjectSummaryTreeError(SUMMARY_TREE_REQUIRES_VECTORS_MESSAGE, 400, SUMMARY_TREE_REQUIRES_VECTORS_CODE);
    }
  }
  let updated;
  try {
    // No pipeline in the input: the stored pipeline is kept and only the tree setting (and, turning it on, summarize) changes.
    updated = await updateProject(project.id, userId, {}, { summaryTree: { enabled: input.enabled } });
  } catch (error) {
    if (error instanceof SummaryTreeConfigError) throw new ProjectSummaryTreeError(error.message, error.status, error.code);
    throw error;
  }
  if (!updated) throw new ProjectSummaryTreeError("Project not found", 404);
  return await getProjectSummaryTreeState({ projectId: updated.id, orgId: updated.orgId, pipeline: normalizePipelineFeatures(updated.pipeline) }, sql, env);
}
