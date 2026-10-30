import {
  embeddingModelBaseUri,
  embeddingModelCatalogByUri,
  indexConfigHash,
  indexConfigOf,
  normalizeStoredPipelineFeatures,
  resolveEmbeddingRoute,
  type EmbeddingConfig,
  type IndexConfig,
  type PipelineFeatures,
} from "@docslurp/shared";

import { sql as defaultSql, type SqlClient } from "../db.js";
import { reciprocalRankFusionScored } from "./rrf.js";

/**
 * Index-config serving (spec 6.2). `workspaces.index_configs` maps `index_config_hash` to the IndexConfig of
 * every index a live document in the workspace is built with (the current one included). While a re-index
 * runs (or after a change that was not re-indexed) search serves each document from the table of the config
 * it was indexed under: one vector search per config, restricted to that config's documents, the query
 * embedded once per distinct vector space, the ranked lists fused with RRF. Their raw scores live in
 * different vector spaces and are never compared.
 */

export type HashFilter = { op: "eq" | "neq"; value: string };

export type IndexServing = { embedding: EmbeddingConfig; hash: HashFilter | null };

export type IndexConfigMap = Record<string, IndexConfig>;

/** At most this many configs are searched per query; the ones with the most documents win. */
export const MAX_SERVED_INDEX_CONFIGS = 3;

type ChunkLike = { id: string; score?: number };

export type ServedSearchDeps<T extends ChunkLike> = {
  /** One-table vector search over documents matching `serving`. */
  search(queryVector: number[], serving: IndexServing | null): Promise<T[]>;
  /** Embeds the query with the given config (records its usage on the search journal). */
  embed(query: string, embedding: EmbeddingConfig): Promise<number[] | null>;
  /** Records a diagnostic on the search journal. */
  diagnostic?(name: string, value: unknown): void;
};

/** Parses the stored map defensively; anything malformed is treated as absent. */
export function parseIndexConfigs(value: unknown): IndexConfigMap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: IndexConfigMap = {};
  for (const [hash, config] of Object.entries(value as Record<string, unknown>)) {
    if (config && typeof config === "object" && typeof (config as IndexConfig).embeddingModel === "string") {
      out[hash] = config as IndexConfig;
    }
  }
  return out;
}

/** The embedding config that reproduces a stored index config's query vectors. */
export function embeddingConfigFor(current: EmbeddingConfig, config: IndexConfig): EmbeddingConfig {
  const native = embeddingModelCatalogByUri[embeddingModelBaseUri(config.embeddingModel)]?.dimensions ?? null;
  return {
    ...current,
    modelUri: config.embeddingModel,
    dimensions: config.dims !== null && config.dims !== native ? config.dims : undefined,
    lateChunking: config.chunking.lateChunking,
    lateChunkingWindow: config.chunking.lateChunkingWindow,
  };
}

const LIVE_VECTORIZED = (sql: SqlClient) => sql`
  d.status = 'completed' and d.superseded_at is null and d.purged_at is null and d.archived_at is null
  and (d.indexing_mode is null or d.indexing_mode = 'full')
  and exists (select 1 from vector_indexes v where v.document_id = d.id)`;

/** Live vectorized documents per index config hash. */
export async function documentCountsByIndexConfig(workspaceId: string, sql: SqlClient = defaultSql): Promise<Map<string, number>> {
  const rows = await sql<{ hash: string | null; n: number }[]>`
    select d.index_config_hash as hash, count(*)::int as n
    from documents d
    where d.workspace_id = ${workspaceId} and ${LIVE_VECTORIZED(sql)}
    group by d.index_config_hash
  `;
  return new Map(rows.filter((row) => row.hash).map((row) => [row.hash!, row.n]));
}

/**
 * Removes map entries no live document is built with and keeps the current config's entry (re-adding it if a
 * stale prune dropped it). The current config is read from the stored pipeline and the update applies only
 * while that pipeline is unchanged: a prune computed from a snapshot taken before a config change would drop
 * the new config's entry while its documents are still being built. Returns the pruned map, or null when the
 * pipeline changed underneath (the next sweep retries). Cheap and idempotent: called by the sweeper and lazily
 * from search.
 */
export async function pruneIndexConfigs(workspaceId: string, sql: SqlClient = defaultSql): Promise<IndexConfigMap | null> {
  const [ws] = await sql<{ pipeline: PipelineFeatures | null }[]>`
    select pipeline from workspaces where id = ${workspaceId} and index_configs is not null
  `;
  if (!ws) return {};
  const current = indexConfigOf(normalizeStoredPipelineFeatures(ws.pipeline ?? null, `workspace ${workspaceId}`));
  const currentHash = indexConfigHash(current);
  const unchanged = ws.pipeline === null
    ? sql`ws.pipeline is null`
    : sql`ws.pipeline = ${sql.json(JSON.parse(JSON.stringify(ws.pipeline)))}::jsonb`;
  const [row] = await sql<{ index_configs: unknown }[]>`
    update workspaces as ws
    set index_configs = (
      select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
      from jsonb_each(ws.index_configs) as e
      where e.key <> ${currentHash}
        and exists (select 1 from documents d where d.workspace_id = ws.id and d.index_config_hash = e.key and ${LIVE_VECTORIZED(sql)})
    ) || jsonb_build_object(${currentHash}::text, ${sql.json(JSON.parse(JSON.stringify(current)))}::jsonb)
    where ws.id = ${workspaceId} and ws.index_configs is not null and ${unchanged}
    returning ws.index_configs
  `;
  return row ? parseIndexConfigs(row.index_configs) : null;
}

/** Sweeper: prunes drained configs in every workspace that still records more than one. */
export async function pruneDrainedIndexConfigs(sql: SqlClient = defaultSql, limit = 50): Promise<number> {
  const rows = await sql<{ id: string }[]>`
    select ws.id from workspaces as ws
    where ws.index_configs is not null and (select count(*) from jsonb_object_keys(ws.index_configs)) > 1
    limit ${limit}
  `;
  let pruned = 0;
  for (const row of rows) {
    const map = await pruneIndexConfigs(row.id, sql);
    if (map && Object.keys(map).length <= 1) pruned += 1;
  }
  return pruned;
}

function spaceKey(embedding: EmbeddingConfig): string {
  const route = resolveEmbeddingRoute(embedding);
  // modelUri, not model: two poolings of one model embed queries differently.
  return `${route.modelUri}\u0000${route.dimensions}`;
}

/**
 * Vector search over every index config a live document is built with. With one config (the common case)
 * it is exactly `deps.search(vector, null)` and runs no query: `indexConfigs` arrives with the workspace
 * pipeline.
 */
export async function servedVectorSearch<T extends ChunkLike>(args: {
  workspaceId: string;
  pipeline: PipelineFeatures;
  indexConfigs: IndexConfigMap;
  queryVector: number[];
  /** The query text to embed for other models (the effective query: rewritten/HyDE when available). */
  query?: string;
  deps: ServedSearchDeps<T>;
  sql?: SqlClient;
}): Promise<T[]> {
  const currentHash = indexConfigHash(indexConfigOf(args.pipeline));
  const hashes = Object.keys(args.indexConfigs).filter((hash) => hash !== currentHash);
  if (hashes.length === 0) return await args.deps.search(args.queryVector, null);

  const counts = await documentCountsByIndexConfig(args.workspaceId, args.sql);
  const drained = hashes.filter((hash) => !counts.get(hash));
  if (drained.length > 0) void pruneIndexConfigs(args.workspaceId, args.sql).catch(() => undefined);
  const others = hashes.filter((hash) => counts.get(hash));
  if (others.length === 0) return await args.deps.search(args.queryVector, null);

  // Serve at most MAX_SERVED_INDEX_CONFIGS configs: the ones with the most documents.
  const candidates = [currentHash, ...others].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0));
  const served = candidates.slice(0, MAX_SERVED_INDEX_CONFIGS);
  if (candidates.length > served.length) {
    args.deps.diagnostic?.("indexConfigs", {
      configs: candidates.length,
      served: served.length,
      skipped: candidates.filter((hash) => !served.includes(hash)).map((hash) => ({ hash, documents: counts.get(hash) ?? 0 })),
    });
  }

  const currentSpace = spaceKey(args.pipeline.embedding);
  const vectors = new Map<string, Promise<number[] | null>>([[currentSpace, Promise.resolve(args.queryVector)]]);
  const lists = await Promise.all(served.map(async (hash) => {
    const config = hash === currentHash ? null : args.indexConfigs[hash]!;
    const embedding = config ? embeddingConfigFor(args.pipeline.embedding, config) : args.pipeline.embedding;
    const key = spaceKey(embedding);
    if (!vectors.has(key)) vectors.set(key, args.query ? args.deps.embed(args.query, embedding) : Promise.resolve(null));
    const vector = await vectors.get(key)!;
    if (!vector) return [] as T[];
    return await args.deps.search(vector, { embedding, hash: { op: "eq", value: hash } });
  }));

  const nonEmpty = lists.filter((list) => list.length > 0);
  if (nonEmpty.length <= 1) return nonEmpty[0] ?? [];
  // Reciprocal rank fusion across vector spaces; scores become RRF scores.
  return reciprocalRankFusionScored(nonEmpty).map(({ item, score }) => ({ ...item, score }));
}
