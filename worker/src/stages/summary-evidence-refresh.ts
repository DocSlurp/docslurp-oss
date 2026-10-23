import type { Document } from "../models.js";
import type { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import { keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";
import { buildSummaryEvidence } from "./summary-evidence.js";

/**
 * Summary evidence is derived from the document's markdown. Any stage that
 * replaces or rewrites that markdown (vision reconciliation, PII redaction)
 * must call this so the summary reads the current text: it rebuilds the
 * evidence from `text` when given, or deletes it so the summary falls back to
 * the markdown artifact. The object is rewritten under its existing key, so a
 * superseded copy (for example unredacted text) does not survive in storage.
 * No-op when the run recorded no evidence (summaries disabled).
 */
export async function refreshSummaryEvidence(args: {
  storage: Pick<ArtifactStore, "bucket" | "putJson" | "deleteKeys">;
  ledger: DocumentArtifactLedger;
  document: Pick<Document, "id" | "pageCount">;
  /** Current markdown text, or null when it could not be read. */
  text: string | null;
  /** URI recorded in the document's `markdown` slot for that text. */
  sourceUri: string | undefined;
}): Promise<"rebuilt" | "deleted" | "absent"> {
  const evidenceUri = args.ledger.readDocument(args.document.id, "summary-evidence");
  if (!evidenceUri) return "absent";
  const key = keyFromStorageUri(evidenceUri, args.storage.bucket);
  if (!key) throw new Error("Summary evidence must be in the configured bucket");
  if (args.text !== null && args.sourceUri) {
    await args.storage.putJson(key, buildSummaryEvidence({
      text: args.text, pageCount: args.document.pageCount,
      documentId: args.document.id, sourceUri: args.sourceUri,
    }));
    return "rebuilt";
  }
  await args.storage.deleteKeys([key]);
  return "deleted";
}
