import {
  isPageWithheld,
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
 * elsewhere cannot unblock it. A document with only some pages withheld is not blocked: see {@link documentPiiWithholding}.
 */
export function isPiiBlockedDocument(state: WorkflowState, document: Document): boolean {
  if (document.status === PII_BLOCKED_DOCUMENT_STATUS) return true;
  return state.documentStage?.(document.id, "pii-detect")?.stats?.blocked === true;
}

/**
 * What the PII policy withholds for a document in this run, from the pii-detect checkpoint (the one source every later
 * stage, resume and reindex in the run shares). Fails closed: a blocked document, or stats that name page withholding
 * without a readable page list, withhold the whole document.
 */
export function documentPiiWithholding(state: WorkflowState, document: Document): PiiWithholding {
  if (isPiiBlockedDocument(state, document)) return { scope: "document", reason: "pii-blocked" };
  const stats = state.documentStage?.(document.id, "pii-detect")?.stats as Record<string, unknown> | undefined;
  if (!stats) return { scope: "none" };
  return piiWithholding({
    status: document.status,
    metadata: {
      pii: {
        blocked: stats.blocked === true,
        scope: stats.withholding ?? "none",
        ...(stats.withholding === "pages" ? { withheldPages: stats.withheldPages } : {}),
        ...(stats.withholding === "sections" ? { withheldSectionCount: stats.withheldSectionCount } : {}),
      },
    },
  });
}

/** Whether a page (or any page of a span) of the document is withheld in this run. Null pages fail closed. */
export function isPageWithheldInRun(
  state: WorkflowState,
  document: Document,
  page: number | readonly (number | null | undefined)[] | null | undefined,
): boolean {
  return isPageWithheld(documentPiiWithholding(state, document), page);
}

type SqlTag = <T>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/**
 * The persisted withholding of a document, for work that runs outside a pipeline run (figure resume, page renders,
 * exports, deferred materialization). A missing document withholds everything.
 */
export async function loadDocumentPiiWithholding(sql: SqlTag, documentId: string): Promise<PiiWithholding> {
  const rows = await sql<Array<{ status: string | null; metadata: unknown }>>`
    select status, metadata from documents where id = ${documentId}
  `;
  const row = rows[0];
  if (!row) return { scope: "document", reason: "missing-document" };
  return piiWithholding(row);
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
