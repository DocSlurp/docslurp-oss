import {
  parserPlaybookCatalog,
  qualityAllowsPageReading,
  qualityReadsEveryPage,
  type ParserPlaybookKey,
  type PipelineFeatures,
} from "@docslurp/shared";

type BudgetPipeline = Pick<PipelineFeatures, "quality">;

const isPlaybook = (value: unknown): value is ParserPlaybookKey =>
  typeof value === "string" && value in parserPlaybookCatalog;

const playbookAllowsVision = (playbook: ParserPlaybookKey): boolean =>
  parserPlaybookCatalog[playbook]?.guidance?.visionAllowed !== false;

/**
 * Whether vision may read this document's pages at all.
 *
 * There is no per-document page count: vision reads every page the routing selects (all of them in `good`),
 * each billed as a Rich page, and run spend is bounded by `pipeline.maxCostCents`. `fast` never reads a page
 * (pages without a text layer are kept as page images). Inside `auto`, a classify-route suggestion of a playbook
 * that disallows vision keeps it off for a document it judged plain text; a suggestion never turns vision on.
 */
export function visionAllowedForDocument(pipeline: BudgetPipeline, suggestedPlaybook?: string | null): boolean {
  if (qualityReadsEveryPage(pipeline.quality)) return true;
  if (!qualityAllowsPageReading(pipeline.quality)) return false;
  return !isPlaybook(suggestedPlaybook) || playbookAllowsVision(suggestedPlaybook);
}
