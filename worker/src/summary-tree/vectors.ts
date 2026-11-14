import { adjacentSimilarities, type VectorLike } from "./grouping.js";
import { leafHash } from "./hash.js";
import { SummaryTreeInputError } from "./limits.js";

/** The part of the embed stage's artifact (`<run root>/embeddings/<documentId>.json`) the tree reads. */
export interface EmbeddingArtifactVectors {
  documentId?: string;
  embedding?: { model?: string; dimensions?: number };
  chunks: ReadonlyArray<{ index: number; vector: VectorLike; metadata?: Record<string, unknown> }>;
}

/** Where chunk vectors come from. Storage sits behind this, so grouping is tested with plain arrays. */
export interface ChunkVectorSource {
  load(): Promise<EmbeddingArtifactVectors>;
}

/** Reads the embed stage's JSON artifact through a storage client's `getJson`. */
export function embeddingArtifactVectorSource(
  storage: { getJson<T>(key: string, options?: { streamJson?: boolean }): Promise<T> },
  key: string,
): ChunkVectorSource {
  return { load: () => storage.getJson<EmbeddingArtifactVectors>(key, { streamJson: true }) };
}

export interface LeafVectorRequest {
  chunkIndex: number;
  /** When set, the artifact chunk's raw text must hash to it, proving the vector is for this text. */
  leafHash?: string;
}

/**
 * Vectors for the given leaves, matched by chunk index. The artifact's own `documentId` is not compared:
 * after content dedup the artifact a document points at can have been written for another document with the
 * same text, and chunk indexes are what the two share. A missing chunk, an empty vector, a dimension that
 * differs from the artifact's profile or a raw-text mismatch throws rather than grouping on partial data.
 */
export function leafVectorsFromArtifact(artifact: EmbeddingArtifactVectors, leaves: readonly LeafVectorRequest[]): VectorLike[] {
  const byIndex = new Map<number, EmbeddingArtifactVectors["chunks"][number]>();
  for (const chunk of artifact.chunks) byIndex.set(chunk.index, chunk);
  const dimensions = artifact.embedding?.dimensions && artifact.embedding.dimensions > 0 ? artifact.embedding.dimensions : null;
  let expected = dimensions;
  return leaves.map((leaf) => {
    const chunk = byIndex.get(leaf.chunkIndex);
    if (!chunk) throw new SummaryTreeInputError(`embedding artifact has no chunk ${leaf.chunkIndex}`);
    const vector = chunk.vector;
    if (!vector || vector.length === 0) throw new SummaryTreeInputError(`embedding artifact chunk ${leaf.chunkIndex} has no vector`);
    expected ??= vector.length;
    if (vector.length !== expected) {
      throw new SummaryTreeInputError(`embedding artifact chunk ${leaf.chunkIndex} has ${vector.length} dimensions, expected ${expected}`);
    }
    if (leaf.leafHash !== undefined) {
      const rawText = chunk.metadata?.rawText;
      if (typeof rawText !== "string" || leafHash(rawText) !== leaf.leafHash) {
        throw new SummaryTreeInputError(`embedding artifact chunk ${leaf.chunkIndex} does not hold this document's text`);
      }
    }
    return vector;
  });
}

/**
 * Similarity between each leaf and the next, which is all leaf grouping needs. The vectors are read in place
 * and not copied, so nothing beyond the loaded artifact and one float per leaf is held.
 */
export async function loadLeafSimilarities(source: ChunkVectorSource, leaves: readonly LeafVectorRequest[]): Promise<Float64Array> {
  const vectors = leafVectorsFromArtifact(await source.load(), leaves);
  return adjacentSimilarities(vectors.length, (position) => vectors[position]!);
}
