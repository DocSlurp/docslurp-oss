import type { Document } from "../models.js";
import type { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import { buildPageOffsetsJsonl, pageOffsetsKey } from "../lib/page-offsets.js";
import { keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";
import { buildSummaryEvidence } from "./summary-evidence.js";

/**
 * Writes the page offset index next to the evidence at `evidenceKey`, or deletes it. `stored` is the text exactly as the
 * Markdown object at `sourceUri` holds it, or null when the caller cannot prove that (the offsets are byte offsets into the
 * stored object, so they are never built from text that might differ from it). A text whose form-feed page count is not
 * `pageCount` has no index either. Never throws: an index failure must not fail the document, so it logs the ids and the
 * error class only (never document text) and carries on; a failed write or delete leaves the reader to reject any stale
 * index by its `sourceBytes` check.
 */
export async function syncPageOffsets(
  storage: Pick<ArtifactStore, "putBytes" | "deleteKeys">,
  args: { evidenceKey: string; documentId: string; pageCount: number; sourceUri: string; stored: string | Buffer | null },
): Promise<"written" | "deleted" | "failed"> {
  const key = pageOffsetsKey(args.evidenceKey);
  try {
    const jsonl = args.stored === null ? null : buildPageOffsetsJsonl({
      markdown: typeof args.stored === "string" ? Buffer.from(args.stored, "utf8") : args.stored, pageCount: args.pageCount, documentId: args.documentId, sourceUri: args.sourceUri,
    });
    if (jsonl === null) {
      await storage.deleteKeys([key]);
      return "deleted";
    }
    await storage.putBytes(key, Buffer.from(jsonl, "utf8"), "application/x-ndjson");
    return "written";
  } catch (error) {
    console.warn(`[summary-evidence] page offsets failed document=${args.documentId} error=${error instanceof Error ? error.name : typeof error}`);
    return "failed";
  }
}

/** Largest stored Markdown read back to build an index: the extract stage's own output bound. */
export const PAGE_OFFSETS_READBACK_MAX_BYTES = 256 * 1024 * 1024;

/**
 * The Markdown object at `sourceUri` as stored, for an index when the caller holds no byte-exact copy. One extra read,
 * so callers use it only for documents a page-addressed reader will open. Null (never throws) when the object is not
 * in the bucket, is empty, is over the bound or cannot be read.
 */
export async function readStoredMarkdown(
  storage: Pick<ArtifactStore, "bucket" | "objectSize" | "getByteRange">, sourceUri: string, signal?: AbortSignal,
): Promise<Buffer | null> {
  try {
    const key = keyFromStorageUri(sourceUri, storage.bucket);
    if (!key) return null;
    const size = await storage.objectSize(key, signal);
    if (!size || size > PAGE_OFFSETS_READBACK_MAX_BYTES) return null;
    const bytes = await storage.getByteRange(key, 0, size - 1, signal);
    return bytes.length === size ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Summary evidence is derived from the document's markdown. Any stage that
 * replaces or rewrites that markdown (vision reconciliation, PII redaction)
 * must call this so the summary reads the current text: it rebuilds the
 * evidence from `text` when given, or deletes it so the summary falls back to
 * the markdown artifact. The object is rewritten under its existing key, so a
 * superseded copy (for example unredacted text) does not survive in storage.
 * No-op when the run recorded no evidence (summaries disabled).
 *
 * The page offset index beside it follows the evidence: rebuilt when `text` is exactly the bytes stored at `sourceUri`
 * (the caller says so with `textIsStored`), deleted otherwise, and deleted with the evidence.
 */
export async function refreshSummaryEvidence(args: {
  storage: Pick<ArtifactStore, "bucket" | "putJson" | "putBytes" | "deleteKeys">;
  ledger: DocumentArtifactLedger;
  document: Pick<Document, "id" | "pageCount">;
  /** Current markdown text, or null when it could not be read. */
  text: string | null;
  /** URI recorded in the document's `markdown` slot for that text. */
  sourceUri: string | undefined;
  /**
   * True only when the object at `sourceUri` is exactly `Buffer.from(text, "utf8")`. Leave it unset when the text was
   * derived from the stored one (blanked pages, redaction not written back, a decoded read): the index is then deleted.
   */
  textIsStored?: boolean;
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
    await syncPageOffsets(args.storage, {
      evidenceKey: key, documentId: args.document.id, pageCount: args.document.pageCount, sourceUri: args.sourceUri,
      stored: args.textIsStored === true ? args.text : null,
    });
    return "rebuilt";
  }
  await args.storage.deleteKeys([key]);
  await syncPageOffsets(args.storage, {
    evidenceKey: key, documentId: args.document.id, pageCount: args.document.pageCount, sourceUri: args.sourceUri ?? "", stored: null,
  });
  return "deleted";
}
