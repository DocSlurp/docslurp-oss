import { parserPlaybookCatalog, type ParserPlaybookKey, type PipelineFeatures } from "@docslurp/shared";

type BudgetPipeline = Pick<PipelineFeatures, "vision"> & { parserPlaybook?: string | null };

const isPlaybook = (value: unknown): value is ParserPlaybookKey =>
  typeof value === "string" && value in parserPlaybookCatalog;

const playbookAllowsVision = (playbook: ParserPlaybookKey): boolean =>
  parserPlaybookCatalog[playbook]?.guidance?.visionAllowed !== false;

/**
 * Whether vision may read this document's pages at all.
 *
 * There is no per-document page count: vision reads every page the routing selects (all of them with
 * `forceAllPages`), each billed as a Rich page, and run spend is bounded by `pipeline.maxCostCents`.
 * A playbook that disallows vision (`fast`) keeps it off, and so does a classify-route suggestion of such
 * a playbook for a document it judged plain text; a suggestion never turns vision on for a workspace whose
 * playbook disallows it.
 */
export function visionAllowedForDocument(pipeline: BudgetPipeline, suggestedPlaybook?: string | null): boolean {
  if (pipeline.vision.forceAllPages) return true;
  const configured = isPlaybook(pipeline.parserPlaybook) ? pipeline.parserPlaybook : "balanced";
  if (!playbookAllowsVision(configured)) return false;
  return !isPlaybook(suggestedPlaybook) || playbookAllowsVision(suggestedPlaybook);
}
