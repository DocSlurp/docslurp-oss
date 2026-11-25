import type { ProjectRunStageState } from "./run.js";

/**
 * Stat a worker puts on a document's stage checkpoint when it completes: the document's page count at that moment.
 * Most stages finish a document's pages together (classification, routing, the page index, the vector index), so the
 * completed checkpoint is their page progress; it costs no write beyond the checkpoint itself.
 */
export const STAGE_DOCUMENT_PAGES_STAT = "documentPages";

type StagePagesInput = {
  /** Stage checkpoints of one run; run-level rows (no `documentId`) are ignored. */
  stages: Iterable<Pick<ProjectRunStageState, "documentId" | "stage" | "status" | "stats">>;
  /** Pages with a completed page checkpoint, by document then stage (`progress.pageRollup.byDocument`). */
  pageProgress?: Readonly<Record<string, Readonly<Record<string, number>>>>;
};

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;

/**
 * Completed pages per stage of one run, from data a progress snapshot already carries. A document counts, per stage,
 * the larger of its page checkpoints and, once its stage checkpoint completed, the page count that checkpoint recorded
 * (`STAGE_DOCUMENT_PAGES_STAT`). Stages that checkpoint page by page therefore advance within a document, and every
 * other stage advances a document at a time instead of reporting nothing until the whole stage ends.
 *
 * A failed or unfinished checkpoint adds only its page checkpoints, and a completed one written by a worker that does
 * not record the stat adds only those too, so the result never claims pages no checkpoint stands for. Several internal
 * checkpoints that map to one public stage count a document once. One pass; memory is one number per document and stage.
 */
export function completedPagesByStage(input: StagePagesInput): Record<string, number> {
  const pages = new Map<string, Map<string, number>>();
  const raise = (stage: string, documentId: string, value: number) => {
    if (value <= 0) return;
    let documents = pages.get(stage);
    if (!documents) pages.set(stage, documents = new Map());
    if (value > (documents.get(documentId) ?? 0)) documents.set(documentId, value);
  };
  for (const [documentId, byStage] of Object.entries(input.pageProgress ?? {})) {
    for (const [stage, completed] of Object.entries(byStage)) raise(stage, documentId, count(completed));
  }
  for (const state of input.stages) {
    if (!state.documentId || state.status !== "completed") continue;
    raise(state.stage, state.documentId, count(state.stats?.[STAGE_DOCUMENT_PAGES_STAT]));
  }
  const totals: Record<string, number> = {};
  for (const [stage, documents] of pages) {
    let total = 0;
    for (const value of documents.values()) total += value;
    totals[stage] = total;
  }
  return totals;
}
