import type { PipelineFeatures, SummaryTreePipelineConfig } from "@docslurp/shared";

import { sql as defaultSql, type SqlClient } from "../db.js";

/*
 * A run's `pipeline.summaryTree` is the project's stored value at the moment the run row is written, never a value
 * carried in from a request, a template or an earlier run's snapshot.
 *
 * Reprocess, bulk reprocess, retry, re-index after a settings change and indexing-mode switches all start from a
 * stored pipeline (the source run's, or the project's as it was when a plan was made). The summary tree is paid,
 * optional work that a project turns off through its own endpoint (project-summary-tree.ts); a replayed "on" must not
 * keep building after that, and a replayed "off" must not hide a tree the project has since turned on. Run creation
 * (run-creation.ts) and every path that inserts or rewrites a run's pipeline directly call this. The worker's stage
 * also reads the project's stored setting before each document (worker/src/stages/summary-tree.ts), so a run that is
 * already queued or running stops building when the project turns the tree off.
 */

/** `pipeline.summaryTree` of a stored project pipeline. Anything but an explicit `enabled: true` is off. */
export function storedSummaryTree(projectPipeline: unknown): SummaryTreePipelineConfig {
  const stored = (projectPipeline as { summaryTree?: { enabled?: unknown } | null } | null | undefined)?.summaryTree;
  return { enabled: stored?.enabled === true };
}

/** The project's stored `pipeline.summaryTree`, read now. A project that does not exist has none: off. */
export async function loadProjectSummaryTree(projectId: string, client: SqlClient = defaultSql): Promise<SummaryTreePipelineConfig> {
  const [row] = await client<{ enabled: boolean | null }[]>`
    select (pipeline -> 'summaryTree' -> 'enabled') = 'true'::jsonb as enabled from projects where id = ${projectId}
  `;
  return { enabled: row?.enabled === true };
}

/** `pipeline` with the project's stored summary-tree setting in place of whatever it carried. */
export function withProjectSummaryTree<T extends PipelineFeatures>(pipeline: T, stored: SummaryTreePipelineConfig): T {
  return { ...pipeline, summaryTree: { enabled: stored.enabled === true } };
}
