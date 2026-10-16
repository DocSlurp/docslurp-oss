import { PII_BLOCKED_DOCUMENT_STATUS } from "@docslurp/shared";

import type { Document } from "../models.js";
import { hasFailedDocumentStage } from "./document-health.js";
import type { WorkflowState } from "./pipeline.js";

/**
 * A document blocked by `piiPolicy.action = "block_indexing"`. Two signals,
 * either one is enough: the persisted document status (reloaded per stage
 * activity) and the pii-detect checkpoint stats (hydrated from
 * document_run_stage_states), so a status write elsewhere cannot unblock it.
 */
export function isPiiBlockedDocument(state: WorkflowState, document: Document): boolean {
  if (document.status === PII_BLOCKED_DOCUMENT_STATUS) return true;
  return state.documentStage?.(document.id, "pii-detect")?.stats?.blocked === true;
}

/**
 * Documents that summary, structured extraction, embedding, graph and index
 * stages may process. A PII-blocked document is terminal: nothing after
 * pii-detect reads, sends or indexes its text. A document that failed a stage
 * has no complete artifacts to read, so it is left out too.
 */
export function indexableDocuments(state: WorkflowState): Document[] {
  return state.documents.filter((document) => !isPiiBlockedDocument(state, document) && !hasFailedDocumentStage(state, document.id));
}
