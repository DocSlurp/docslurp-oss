import type { Document } from "../models.js";
import { keyFromStorageUri, type ArtifactStore } from "../tools/storage.js";

export const SUMMARY_SOURCE_MAX_BYTES = 256 * 1024;
const MANIFEST_MAX_BYTES = 64 * 1024;
const RANGE_COUNT = 16;

/** No PDF parser fallback: summaries consume already-extracted text only. */
export async function readSummarySource(
  storage: Pick<ArtifactStore, "bucket" | "objectSize" | "getByteRange">,
  document: Pick<Document, "sourceKey" | "mimeType">,
  artifactUri: string | undefined,
  signal?: AbortSignal,
): Promise<{ text: string; sourceBytes: number; readBytes: number; sampled: boolean } | null> {
  signal?.throwIfAborted();
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
