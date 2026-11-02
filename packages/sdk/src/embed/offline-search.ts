class UnsafeLanceMetadataError extends Error {}
async function assertNumericLanceTable(table: {schema(): Promise<{metadata: Map<string,string>}>}): Promise<void> {
  if ((await table.schema()).metadata.has("embedding_functions")) {
    throw new UnsafeLanceMetadataError("Offline search refuses persisted embedding_functions metadata");
  }
}

export type SearchResult = {
  text: string;
  score: number;
  citation: {
    documentId: string;
    filename: string;
    pageNumber: number | null;
    headingPath: string[];
    chunkIndex: number;
  };
};

export type OfflineSearchSourceRecord = {
  id?: string;
  text: string;
  citation: SearchResult["citation"];
  metadata?: Record<string, unknown>;
};

export type OfflineEmbeddingConfig = {
  model?: string;
  dimensions?: number;
  normalize?: boolean;
  dtype?: string;
  modelBaseUrl?: string;
};

export type OfflineSearchRecord = OfflineSearchSourceRecord & {
  id: string;
  embedding: number[];
};

export type OfflineSearchBundle = {
  version: 1;
  createdAt: string;
  embedding: Required<Pick<OfflineEmbeddingConfig, "model" | "dimensions" | "normalize" | "dtype">> & {
    provider: "transformers.js";
    modelBaseUrl?: string;
  };
  records: OfflineSearchRecord[];
  lancedb?: {
    path: string;
    tableName: string;
  };
};

export type CreateOfflineSearchBundleOptions = {
  records: OfflineSearchSourceRecord[];
  outputPath?: string;
  lancedbPath?: string;
  lancedbTableName?: string;
  embedding?: OfflineEmbeddingConfig;
};

export type OfflineSearchClientOptions = {
  bundle?: OfflineSearchBundle;
  bundleUrl?: string;
  fetch?: typeof globalThis.fetch;
  embedding?: OfflineEmbeddingConfig;
  preferLanceDb?: boolean;
  lancedbPath?: string;
  lancedbTableName?: string;
};

export type OfflineSearchClient = {
  search(query: string, options?: { limit?: number }): Promise<SearchResult[]>;
  getBundle(): Promise<OfflineSearchBundle>;
};

type FeatureExtractionPipeline = (
  input: string | string[],
  options?: { pooling?: "mean"; normalize?: boolean }
) => Promise<{ tolist?: () => unknown; data?: ArrayLike<number> }>;

const DEFAULT_OFFLINE_EMBEDDING: Required<Pick<OfflineEmbeddingConfig, "model" | "dimensions" | "normalize" | "dtype">> = {
  model: "Xenova/bge-m3",
  dimensions: 1024,
  normalize: true,
  dtype: "q8"
};

const pipelineCache = new Map<string, Promise<FeatureExtractionPipeline>>();

export async function createOfflineSearchBundle(options: CreateOfflineSearchBundleOptions): Promise<OfflineSearchBundle> {
  const embedding = {
    ...DEFAULT_OFFLINE_EMBEDDING,
    ...(options.embedding ?? {})
  };

  const records: OfflineSearchRecord[] = [];
  for (const [index, record] of options.records.entries()) {
    const id = record.id ?? `${record.citation.documentId}:${record.citation.chunkIndex}:${index}`;
    const vector = await embedOfflineText(record.text, embedding);
    records.push({
      ...record,
      id,
      embedding: vector
    });
  }

  const bundle: OfflineSearchBundle = {
    version: 1,
    createdAt: new Date().toISOString(),
    embedding: {
      provider: "transformers.js",
      model: embedding.model,
      dimensions: embedding.dimensions,
      normalize: embedding.normalize,
      dtype: embedding.dtype,
      modelBaseUrl: options.embedding?.modelBaseUrl
    },
    records
  };

  if (options.outputPath) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(options.outputPath), { recursive: true });
    await fs.writeFile(options.outputPath, JSON.stringify(bundle, null, 2), "utf8");
  }

  if (options.lancedbPath) {
    const tableName = options.lancedbTableName ?? "docslurp_offline_search";
    await writeOfflineBundleToLanceDb({
      path: options.lancedbPath,
      tableName,
      records
    });
    bundle.lancedb = {
      path: options.lancedbPath,
      tableName
    };
  }

  return bundle;
}

export function createOfflineSearchClient(options: OfflineSearchClientOptions): OfflineSearchClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  let bundlePromise: Promise<OfflineSearchBundle> | null = null;

  async function getBundle(): Promise<OfflineSearchBundle> {
    if (options.bundle) {
      return options.bundle;
    }

    if (!bundlePromise) {
      if (!options.bundleUrl) {
        throw new Error("Offline search requires either a bundle object or bundleUrl.");
      }
      if (!fetchImpl) {
        throw new Error("A fetch implementation is required to load an offline search bundle URL.");
      }
      bundlePromise = (async () => {
        const response = await fetchImpl(options.bundleUrl!);
        if (!response.ok) {
          throw new Error(`Unable to load offline search bundle: ${response.status}`);
        }
        return (await response.json()) as OfflineSearchBundle;
      })();
    }

    return await bundlePromise;
  }

  return {
    getBundle,
    search: async (query, searchOptions) => {
      const limit = Math.max(1, searchOptions?.limit ?? 8);
      const bundle = await getBundle();
      if (!query.trim()) {
        return [];
      }

      if (canUseNodeLanceDb(options, bundle)) {
        const lanceResults = await searchOfflineBundleWithLanceDb(query, {
          bundle,
          limit,
          path: options.lancedbPath ?? bundle.lancedb?.path ?? "",
          tableName: options.lancedbTableName ?? bundle.lancedb?.tableName ?? "docslurp_offline_search",
          embedding: {
            model: bundle.embedding.model,
            dimensions: bundle.embedding.dimensions,
            normalize: bundle.embedding.normalize,
            dtype: bundle.embedding.dtype,
            ...(options.embedding ?? {})
          }
        });
        if (lanceResults.length > 0) {
          return lanceResults;
        }
      }

      const vector = await embedOfflineText(query, {
        model: bundle.embedding.model,
        dimensions: bundle.embedding.dimensions,
        normalize: bundle.embedding.normalize,
        dtype: bundle.embedding.dtype,
        ...(options.embedding ?? {})
      });

      return bundle.records
        .map((record) => ({
          text: record.text,
          score: cosineSimilarity(vector, record.embedding),
          citation: record.citation
        }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);
    }
  };
}

async function searchOfflineBundleWithLanceDb(
  query: string,
  args: {
    bundle: OfflineSearchBundle;
    path: string;
    tableName: string;
    limit: number;
    embedding: OfflineEmbeddingConfig;
  }
): Promise<SearchResult[]> {
  try {
    const lancedb = await import("@lancedb/lancedb");
    const db = await lancedb.connect(args.path);
    try {
    const table = await db.openTable(args.tableName);
    try {
    await assertNumericLanceTable(table);
    const vector = await embedOfflineText(query, args.embedding);
    const rows = await table.vectorSearch(vector).column("vector").limit(args.limit).toArray() as Array<{
      text: string;
      documentId: string;
      filename: string;
      pageNumber: number | null;
      chunkIndex: number;
      headingPathJson?: string;
      _distance?: number;
    }>;

    return rows.map((row) => ({
      text: row.text,
      score: 1 / (1 + (row._distance ?? 0)),
      citation: {
        documentId: row.documentId,
        filename: row.filename,
        pageNumber: row.pageNumber ?? null,
        chunkIndex: row.chunkIndex,
        headingPath: readHeadingPath(row.headingPathJson)
      }
    }));
    } finally { table.close(); }
    } finally { db.close(); }
  } catch (error) {
    if (error instanceof UnsafeLanceMetadataError) throw error;
    return [];
  }
}

async function writeOfflineBundleToLanceDb(args: {
  path: string;
  tableName: string;
  records: OfflineSearchRecord[];
}) {
  const lancedb = await import("@lancedb/lancedb");
  const db = await lancedb.connect(args.path);

  try {
  const rows = args.records.map((record) => ({
    id: record.id,
    vector: record.embedding,
    text: record.text,
    documentId: record.citation.documentId,
    filename: record.citation.filename,
    pageNumber: record.citation.pageNumber,
    chunkIndex: record.citation.chunkIndex,
    headingPathJson: JSON.stringify(record.citation.headingPath)
  }));

  const tableNames = await db.tableNames();
  if (tableNames.includes(args.tableName)) {
    const table = await db.openTable(args.tableName);
    try {
      await assertNumericLanceTable(table);
      await table.add(rows, { mode: "overwrite" });
      return;
    } finally { table.close(); }
  }

  (await db.createTable(args.tableName, rows)).close();
  } finally { db.close(); }
}

async function embedOfflineText(value: string, options: OfflineEmbeddingConfig): Promise<number[]> {
  const resolved = {
    ...DEFAULT_OFFLINE_EMBEDDING,
    ...options
  };
  const pipeline = await getOfflineEmbeddingPipeline(resolved);
  const output = await pipeline(value, {
    pooling: "mean",
    normalize: resolved.normalize
  });
  return truncateEmbedding(readEmbeddingVector(output), resolved.dimensions);
}

async function getOfflineEmbeddingPipeline(options: Required<Pick<OfflineEmbeddingConfig, "model" | "dtype">> & Partial<OfflineEmbeddingConfig>): Promise<FeatureExtractionPipeline> {
  const cacheKey = `${options.model}:${options.dtype}:${options.modelBaseUrl ?? ""}`;
  let cached = pipelineCache.get(cacheKey);
  if (!cached) {
    cached = (async () => {
      const transformers = await import("@huggingface/transformers");
      configureTransformersRuntime(transformers, options.modelBaseUrl);
      const createPipeline = transformers.pipeline as unknown as (
        task: "feature-extraction",
        model: string,
        options: { dtype?: string }
      ) => Promise<FeatureExtractionPipeline>;

      for (const dtype of [options.dtype, "fp32"]) {
        try {
          return await createPipeline("feature-extraction", options.model, { dtype });
        } catch (error) {
          if (dtype === "fp32") {
            throw error;
          }
        }
      }

      throw new Error(`Unable to initialize offline embedding pipeline for ${options.model}.`);
    })();
    cached.catch(() => {
      pipelineCache.delete(cacheKey);
    });
    pipelineCache.set(cacheKey, cached);
  }

  return await cached;
}

function configureTransformersRuntime(transformers: unknown, modelBaseUrl?: string) {
  const runtime = transformers as {
    env?: {
      allowRemoteModels?: boolean;
      allowLocalModels?: boolean;
      localModelPath?: string;
      backends?: { onnx?: { wasm?: { wasmPaths?: unknown } } };
    };
  };

  if (!runtime.env || !modelBaseUrl) {
    return;
  }

  runtime.env.allowLocalModels = true;
  runtime.env.allowRemoteModels = false;
  runtime.env.localModelPath = modelBaseUrl;
  if (runtime.env.backends?.onnx?.wasm) {
    runtime.env.backends.onnx.wasm.wasmPaths = modelBaseUrl;
  }
}

function cosineSimilarity(left: number[], right: number[]): number {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

function readEmbeddingVector(output: { tolist?: () => unknown; data?: ArrayLike<number> }): number[] {
  if (typeof output.tolist === "function") {
    const rows = output.tolist();
    if (Array.isArray(rows) && Array.isArray(rows[0])) {
      return (rows[0] as unknown[]).map((value) => Number(value));
    }
    if (Array.isArray(rows)) {
      return rows.map((value) => Number(value));
    }
  }

  if (output.data) {
    return Array.from(output.data, (value) => Number(value));
  }

  throw new Error("Offline embedding pipeline returned an unexpected payload.");
}

function truncateEmbedding(embedding: number[], dimensions: number | undefined): number[] {
  if (!dimensions || embedding.length <= dimensions) {
    return embedding;
  }
  return embedding.slice(0, dimensions);
}

function readHeadingPath(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
  } catch {
    return [];
  }
}

function canUseNodeLanceDb(options: OfflineSearchClientOptions, bundle: OfflineSearchBundle) {
  return typeof window === "undefined"
    && (options.preferLanceDb ?? true)
    && Boolean(options.lancedbPath ?? bundle.lancedb?.path);
}
