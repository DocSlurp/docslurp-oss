import { SUMMARY_EVIDENCE_MAX_BYTES, SUMMARY_INPUT_MAX_BYTES, type SummaryEvidence } from "./summary-evidence.js";
import type { Document } from "../models.js";
import { keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";

export const SUMMARY_SOURCE_MAX_BYTES = SUMMARY_INPUT_MAX_BYTES;
const MANIFEST_MAX_BYTES = 4000;
const RANGE_COUNT = 4;

/** No PDF parser fallback: summaries consume already-extracted text only. */
export async function readSummarySource(
  storage: Pick<ArtifactStore, "bucket" | "objectSize" | "getByteRange">,
  document: Pick<Document, "sourceKey" | "mimeType"> & { id?: string },
  artifactUri: string | undefined,
  signal?: AbortSignal,
  evidenceUri?: string,
): Promise<{ text: string; sourceBytes: number; readBytes: number; sampled: boolean; coverage?: { totalPages: number | null; pages: Array<{ pageNumber: number; clipped: boolean }>; pageReferences: "verified" | "unavailable" } } | null> {
  signal?.throwIfAborted();
  if (evidenceUri) {
    const evidenceKey = keyFromStorageUri(evidenceUri, storage.bucket);
    if (!evidenceKey) throw new Error("Summary evidence must be in the configured bucket");
    const size = await storage.objectSize(evidenceKey, signal);
    if (size && size <= SUMMARY_EVIDENCE_MAX_BYTES) {
      const bytes = await storage.getByteRange(evidenceKey, 0, size - 1, signal);
      const evidence = parseEvidence(JSON.parse(bytes.toString("utf8")));
      if (evidence.documentId !== document.id) {
        throw new Error("Summary evidence does not match the current document");
      }
      if (evidence.sourceUri === artifactUri) {
        return { text: evidence.text, sourceBytes: evidence.sourceBytes, readBytes: bytes.length,
          sampled: evidence.sampled, coverage: { totalPages: evidence.totalPages,
            pages: evidence.pages, pageReferences: evidence.pageReferences } };
      }
      // A later stage replaced the markdown without refreshing the evidence:
      // it describes superseded text, so summarize the current artifact instead.
      console.warn(`[document-summary] stale_summary_evidence document=${document.id} evidence_source=${evidence.sourceUri} markdown=${artifactUri ?? "none"}`);
    } else if (size) {
      throw new Error("Summary evidence exceeds the byte budget");
    }
  }
  let key = artifactUri ? keyFromStorageUri(artifactUri, storage.bucket) : null;
  if (!artifactUri && document.mimeType?.startsWith("text/")) key = document.sourceKey;
  if (!key) return null;

  let size = await storage.objectSize(key, signal);
  if (size === null || size === 0) return null;
  let readBytes = 0;
  if (artifactUri?.endsWith(".json")) {
    if (size > MANIFEST_MAX_BYTES) return null;
    const bytes = await storage.getByteRange(key, 0, size - 1, signal);
    readBytes += bytes.length;
    const manifest: unknown = JSON.parse(bytes.toString("utf8"));
    const nestedUri = manifest && typeof manifest === "object" && "textArtifactUri" in manifest
      ? manifest.textArtifactUri : null;
    key = typeof nestedUri === "string" ? keyFromStorageUri(nestedUri, storage.bucket) : null;
    if (!key) return null;
    size = await storage.objectSize(key, signal);
    if (size === null || size === 0) return null;
  }
  if (size <= SUMMARY_SOURCE_MAX_BYTES) {
    const bytes = await storage.getByteRange(key, 0, size - 1, signal);
    return { text: bytes.toString("utf8"), sourceBytes: size, readBytes: readBytes + bytes.length, sampled: false };
  }

  const rangeBytes = SUMMARY_SOURCE_MAX_BYTES / RANGE_COUNT;
  const excerpts: string[] = [];
  for (let index = 0; index < RANGE_COUNT; index++) {
    signal?.throwIfAborted();
    const start = Math.floor(index * (size - rangeBytes) / (RANGE_COUNT - 1));
    const bytes = await storage.getByteRange(key, start, start + rangeBytes - 1, signal);
    readBytes += bytes.length;
    // Ranges can begin/end inside a UTF-8 code point: drop only the damaged edge.
    const text = bytes.toString("utf8").replace(/^\uFFFD+|\uFFFD+$/g, "");
    excerpts.push(`[Source bytes ${start}-${start + rangeBytes - 1} of ${size}]\n${text}`);
  }
  return { text: excerpts.join("\n\n"), sourceBytes: size, readBytes, sampled: true };
}

function parseEvidence(value: unknown): SummaryEvidence {
  if (!value || typeof value !== "object") throw new Error("Invalid summary evidence");
  const v = value as Partial<SummaryEvidence>;
  if (v.version !== 1 || typeof v.documentId !== "string" || typeof v.sourceUri !== "string"
    || typeof v.text !== "string" || Buffer.byteLength(v.text) > SUMMARY_INPUT_MAX_BYTES
    || typeof v.sourceBytes !== "number" || !Number.isSafeInteger(v.sourceBytes) || v.sourceBytes < 0
    || typeof v.sampled !== "boolean"
    || !(v.totalPages === null || (typeof v.totalPages === "number" && Number.isSafeInteger(v.totalPages) && v.totalPages > 0))
    || !["verified", "unavailable"].includes(v.pageReferences ?? "")
    || !Array.isArray(v.pages) || v.pages.length > 10
    || !v.pages.every((p) => p && Number.isSafeInteger(p.pageNumber) && p.pageNumber > 0
      && v.totalPages !== null && p.pageNumber <= v.totalPages! && typeof p.clipped === "boolean")) {
    throw new Error("Invalid summary evidence");
  }
  return v as SummaryEvidence;
}
