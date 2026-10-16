import type { Document } from "../models.js";
import type { WorkflowState } from "./pipeline.js";

/**
 * The Document exhausted its strategies in an earlier stage. Later stages skip
 * it; the Run goes on with the Documents that can still succeed.
 */
export function hasFailedDocumentStage(
  state: Pick<WorkflowState, "documentStages">,
  documentId: string,
  exceptStage?: string,
): boolean {
  for (const [stageName, stage] of state.documentStages?.get(documentId) ?? []) {
    if (stage.status === "failed" && stageName !== exceptStage) return true;
  }
  return false;
}

/** Documents with no failed stage: the ones cross-document stages may still read. */
export function healthyDocuments(
  state: Pick<WorkflowState, "documents" | "documentStages">,
): Document[] {
  return state.documents.filter((document) => !hasFailedDocumentStage(state, document.id));
}
