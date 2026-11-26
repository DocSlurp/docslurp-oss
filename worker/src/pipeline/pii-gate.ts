import {
  PII_BLOCKED_DOCUMENT_STATUS,
  piiWithholding,
  type PiiWithholding,
} from "@docslurp/shared";

import type { Document } from "../models.js";
import { hasFailedDocumentStage } from "./document-health.js";
import type { WorkflowState } from "./pipeline.js";

/**
 * A document the PII policy withheld whole (`block_document`, every page withheld under `block_indexing`, or a match
 * that could not be placed on a page). Two signals, either one is enough: the persisted document status (reloaded per
 * stage activity) and the pii-detect checkpoint stats (hydrated from document_run_stage_states), so a status write
 * elsewhere cannot unblock it. A document with only some pages withheld is not blocked: pii-detect already replaced those pages' text, so later stages
 * in the run read only rewritten text; work outside a run reads the stored outcome ({@link loadDocumentPiiWithholding}).
 */
export function isPiiBlockedDocument(state: WorkflowState, document: Document): boolean {
  if (document.status === PII_BLOCKED_DOCUMENT_STATUS) return true;
  return state.documentStage?.(document.id, "pii-detect")?.stats?.blocked === true;
}

type SqlTag = <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/**
 * The persisted withholding of a document, for work that runs outside a pipeline run (figure resume, page renders,
 * exports, deferred materialization). A missing document withholds everything.
 */
export async function loadDocumentPiiWithholding(sql: SqlTag, documentId: string): Promise<PiiWithholding> {
  const rows = await sql<Array<{ status: string | null; metadata: unknown; indexing_mode: string | null }>>`
    select status, metadata, indexing_mode from documents where id = ${documentId}
  `;
  const row = rows[0];
  if (!row) return { scope: "document", reason: "missing-document" };
  return piiWithholding({ status: row.status, metadata: row.metadata, indexingMode: row.indexing_mode });
}

/**
 * Documents that summary, structured extraction, embedding, graph and index
 * stages may process. A PII-blocked document is terminal: nothing after
 * pii-detect reads, sends or indexes its text. A document with some pages
 * withheld is processed: pii-detect already replaced those pages' text. A
 * document that failed a stage has no complete artifacts to read, so it is
 * left out too.
 */
export function indexableDocuments(state: WorkflowState): Document[] {
  return state.documents.filter((document) => !isPiiBlockedDocument(state, document) && !hasFailedDocumentStage(state, document.id));
}
