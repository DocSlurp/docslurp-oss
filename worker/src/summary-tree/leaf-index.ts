import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { JSONParser } from "@streamparser/json";

import { cosineSimilarity, type SummaryTreeLeafRef } from "./grouping.js";
import { leafHash, normalizeHeadingPath } from "./hash.js";
import { createSummaryTreeLeafSelector, summaryTreeChunkFromEmbeddingChunk, type EmbeddingChunkLike, type SummaryTreeLeafCounts } from "./leaves.js";
import { SummaryTreeInputError, type SummaryTreeLimits } from "./limits.js";

/*
 * One pass over a document's embed artifact that keeps what the tree needs and nothing else.
 *
 * The artifact (`<run root>/embeddings/<documentId>.json`) holds every chunk with its vector; for a
 * 20,000-page document that is tens of thousands of vectors. The scan parses it as a stream, one chunk at a
 * time. Per leaf it keeps a position record (chunk index, heading path, pages), the leaf hash and the cosine
 * similarity to the previous leaf; the vector is dropped as soon as the next leaf has been compared with it,
 * and the raw text goes to a file on local disk, read back one group at a time when its prompt is built.
 * Memory therefore grows with the number of leaves by a few dozen bytes each, not with their text or vectors.
 */

/** Raw leaf text kept off the heap: appended in leaf order during the scan, read back by leaf position. */
export interface LeafTextStore {
  append(texts: readonly string[]): Promise<void>;
  read(positions: readonly number[]): Promise<string[]>;
  dispose(): Promise<void>;
}

/** A leaf text store in a private temporary directory (`TMPDIR`), removed by `dispose`. */
export async function createLeafTextSpool(options: { directory?: string } = {}): Promise<LeafTextStore> {
  const directory = await mkdtemp(path.join(options.directory ?? tmpdir(), "docslurp-summary-tree-"));
  let file: FileHandle | null = await open(path.join(directory, "leaves.txt"), "wx+", 0o600);
  // offsets[i] is where leaf i starts; the last entry is the end of the file.
  const offsets: number[] = [0];
  const handle = () => {
    if (!file) throw new SummaryTreeInputError("summary tree leaf text was read after it was disposed");
    return file;
  };
  return {
    async append(texts) {
      if (texts.length === 0) return;
      const buffers = texts.map((text) => Buffer.from(text, "utf8"));
      let end = offsets[offsets.length - 1]!;
      const start = end;
      for (const buffer of buffers) {
        end += buffer.length;
        offsets.push(end);
      }
      await handle().write(Buffer.concat(buffers), 0, end - start, start);
    },
    async read(positions) {
      const out: string[] = [];
      for (const position of positions) {
        const start = offsets[position];
        const end = offsets[position + 1];
        if (start === undefined || end === undefined) throw new SummaryTreeInputError(`summary tree leaf ${position} has no stored text`);
        const buffer = Buffer.alloc(end - start);
        if (buffer.length > 0) await handle().read(buffer, 0, buffer.length, start);
        out.push(buffer.toString("utf8"));
      }
      return out;
    },
    async dispose() {
      const open = file;
      file = null;
      await open?.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export interface SummaryTreeLeafIndex {
  /** Leaves in document order. Empty when the document is skipped. */
  leaves: SummaryTreeLeafRef[];
  /** `hashes[i]` is the leaf hash of `leaves[i]` (sha256 of its normalized raw text). */
  hashes: string[];
  /** `similarities[i]` is the cosine similarity of the vectors of leaf `i` and leaf `i + 1`. */
  similarities: Float64Array;
  counts: SummaryTreeLeafCounts;
  /** The embedding space the artifact's vectors are in: its recorded model, and the dimension every leaf vector had. */
  embedding: { model: string | null; dimensions: number | null };
}

type ArtifactChunk = EmbeddingChunkLike & { vector?: ArrayLike<number> };

/**
 * Reads an embed artifact as a byte stream and returns the leaf index. Leaf texts are appended to `texts` in
 * leaf order (`texts.read([i])` is the text of `leaves[i]`).
 *
 * Chunks are matched by index, never by the artifact's own `documentId`: after content dedup the artifact a
 * document points at can have been written for another document with the same text. A leaf without a vector, or
 * with a vector of another dimension than the leaves before it, throws rather than grouping on partial data.
 */
export async function scanEmbeddingArtifactLeaves(args: {
  bytes: AsyncIterable<Uint8Array>;
  document: { normalizedFormat?: string | null; mimeType?: string | null };
  texts: Pick<LeafTextStore, "append">;
  limits?: Partial<SummaryTreeLimits>;
  signal?: AbortSignal;
  /** Called as the scan advances, so a long artifact does not look like stalled work. */
  onProgress?: () => void;
}): Promise<SummaryTreeLeafIndex> {
  const selector = createSummaryTreeLeafSelector(args.document, args.limits);
  const leaves: SummaryTreeLeafRef[] = [];
  const hashes: string[] = [];
  const similarities: number[] = [];
  let pendingTexts: string[] = [];
  let previousVector: ArrayLike<number> | null = null;
  let dimensions: number | null = null;
  let model: string | null = null;
  let recordedDimensions: number | null = null;
  // Adjacent leaves usually share a heading: keep one array per run instead of one per leaf.
  let lastPathKey = "";
  let lastPath: string[] = [];
  let failure: unknown = null;

  const onChunk = (chunk: ArtifactChunk) => {
    const converted = summaryTreeChunkFromEmbeddingChunk(chunk);
    const verdict = selector.add(converted);
    if (verdict.kind !== "leaf") return;
    const vector = chunk.vector;
    if (!vector || vector.length === 0) throw new SummaryTreeInputError(`embedding artifact chunk ${chunk.index} has no vector`);
    dimensions ??= vector.length;
    if (vector.length !== dimensions) {
      throw new SummaryTreeInputError(`embedding artifact chunk ${chunk.index} has ${vector.length} dimensions, expected ${dimensions}`);
    }
    if (previousVector) similarities.push(cosineSimilarity(previousVector, vector));
    previousVector = vector;
    const normalized = normalizeHeadingPath(converted.headingPath);
    const key = JSON.stringify(normalized);
    if (key !== lastPathKey || leaves.length === 0) {
      lastPathKey = key;
      lastPath = normalized;
    }
    leaves.push({ chunkIndex: converted.index, headingPath: lastPath, pageStart: verdict.pageStart, pageEnd: verdict.pageEnd });
    hashes.push(leafHash(converted.rawText));
    pendingTexts.push(converted.rawText);
  };

  const parser = new JSONParser({ paths: ["$.embedding", "$.chunks.*"], keepStack: false, stringBufferSize: 64 * 1024 });
  parser.onValue = ({ value, key }) => {
    if (failure) return;
    try {
      if (key === "embedding") {
        const profile = value as { model?: unknown; dimensions?: unknown } | null;
        if (typeof profile?.model === "string") model = profile.model;
        if (typeof profile?.dimensions === "number" && profile.dimensions > 0) recordedDimensions = profile.dimensions;
      } else if (typeof key === "number" && value && typeof value === "object") {
        onChunk(value as unknown as ArtifactChunk);
      }
    } catch (error) {
      failure = error;
    }
  };
  let received = 0;
  for await (const bytes of args.bytes) {
    args.signal?.throwIfAborted();
    if (++received % 64 === 0) args.onProgress?.();
    parser.write(bytes);
    if (failure) throw failure;
    if (pendingTexts.length > 0) {
      const batch = pendingTexts;
      pendingTexts = [];
      await args.texts.append(batch);
    }
  }
  if (!parser.isEnded) parser.end();
  if (failure) throw failure;
  if (pendingTexts.length > 0) await args.texts.append(pendingTexts);

  if (recordedDimensions !== null && dimensions !== null && recordedDimensions !== dimensions) {
    throw new SummaryTreeInputError(`embedding artifact records ${recordedDimensions} dimensions but its vectors have ${dimensions}`);
  }
  const counts = selector.finish();
  const kept = counts.skipReason === null;
  return {
    leaves: kept ? leaves : [],
    hashes: kept ? hashes : [],
    similarities: kept ? Float64Array.from(similarities) : new Float64Array(0),
    counts,
    embedding: { model, dimensions: dimensions ?? recordedDimensions },
  };
}
