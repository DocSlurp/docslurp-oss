import { parserPlaybookCatalog, type ParserPlaybookKey, type PipelineFeatures } from "@docslurp/shared";

type BudgetPipeline = Pick<PipelineFeatures, "vision"> & { parserPlaybook?: string | null };

const isPlaybook = (value: unknown): value is ParserPlaybookKey =>
  typeof value === "string" && value in parserPlaybookCatalog;

/**
 * Pages per document that vision may process.
 *
 * `forceAllPages` uses the workspace's `vision.maxPagesPerDocument`. Otherwise the run's
 * parser playbook (workspace choice, `balanced` by default) sets the budget. classify-route
 * may suggest another playbook per document. The suggestion can lower the budget (a simple
 * text document needs no vision) or raise it for degraded or scanned documents, up to
 * VISION_ESCALATION_MAX_PAGES. A workspace whose playbook allows no vision (budget 0, e.g.
 * `fast`) is never escalated.
 */
export const VISION_ESCALATION_MAX_PAGES = 12;

export function resolveVisionPageBudget(pipeline: BudgetPipeline, suggestedPlaybook?: string | null): number {
  if (pipeline.vision.forceAllPages) return Math.max(0, pipeline.vision.maxPagesPerDocument);
  const configuredPlaybook = isPlaybook(pipeline.parserPlaybook) ? pipeline.parserPlaybook : "balanced";
  const configured =
    parserPlaybookCatalog[configuredPlaybook]?.guidance?.visionMaxPagesPerDocument ?? pipeline.vision.maxPagesPerDocument;
  if (!isPlaybook(suggestedPlaybook) || suggestedPlaybook === configuredPlaybook) return Math.max(0, configured);
  const suggested = parserPlaybookCatalog[suggestedPlaybook]?.guidance?.visionMaxPagesPerDocument ?? configured;
  if (suggested <= configured) return Math.max(0, suggested);
  if (configured <= 0) return 0;
  return Math.min(suggested, Math.max(configured, VISION_ESCALATION_MAX_PAGES));
}
