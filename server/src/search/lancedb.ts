import { startDependencySpan, withDependencySpan } from "@docslurp/shared/observability";
/**
 * LanceDB vector search service for query-time ANN retrieval.
 *
 * Connects to LanceDB (local filesystem or S3-backed; see LANCEDB_URI in
 * @docslurp/shared connection-uri),
 * opens the exact per-org table derived from trusted workspace access,
 * and runs cosine similarity search inside that storage boundary.
 */
import * as lancedb from "@lancedb/lancedb";

import { resolveLanceDbConfig, VectorNamespaceManager, type PrivacyMode } from "@docslurp/shared";
import { LANCE_HYDRATION_COLUMNS } from "@docslurp/shared/lancedb-hydration";
import { withLanceDdb } from "@docslurp/shared/lancedb-ddb";
import { withLanceS3Proxy, withLanceSearchSpan } from "@docslurp/shared/lancedb-s3-trace";

import { formatLanceSessionLog, resolveLanceSessionConfig, type LanceSessionConfig } from "@docslurp/shared/lancedb-session";

import { lanceDbQueryTuning } from "./lancedb-query-tuning.js";
import { prewarmTable } from "./lancedb-prewarm.js";
import { resultCache, resultCacheKey } from "./result-cache.js";
import { countSearchEvent } from "./timings.js";

/**
 * Connections and table handles are reused across searches. Opening them per
 * search re-read manifests (and, on object storage, index and vector pages)
 * from S3 on every query: about two seconds per search in production.
 * - One Session (index + metadata caches, sized by LANCEDB_INDEX_CACHE_MB /
 *   LANCEDB_METADATA_CACHE_MB) is shared by every connection, and indexes are
 *   prewarmed into it when a table opens (see lancedb-prewarm.ts).
 * - Tables check for new versions at most every LANCEDB_READ_CONSISTENCY_SECONDS
 *   (default 10), so newly indexed rows appear within that interval.
 * - A table that does not exist yet is remembered for MISSING_TABLE_TTL_MS
 *   (5 min), so absent legacy tables don't cost S3 round trips on queries.
 * - A handle that errors is dropped and reopened on the next search.
 */
let sessionState: { config: LanceSessionConfig; session: lancedb.Session; timer: NodeJS.Timeout } | undefined;
const lastPrewarm = new Map<string, number>();

function lanceSession(): { config: LanceSessionConfig; session: lancedb.Session } {
  if (!sessionState) {
    const config = resolveLanceSessionConfig();
    const session = new lancedb.Session(BigInt(config.indexCacheBytes), BigInt(config.metadataCacheBytes));
    console.log(formatLanceSessionLog("created", config));
    const timer = setInterval(() => {
      console.log(formatLanceSessionLog("stats", config, { sizeBytes: session.sizeBytes(), approxNumItems: session.approxNumItems() }));
    }, 60_000);
    timer.unref();
    sessionState = { config, session, timer };
  }
  return sessionState;
}

/** Current session cache usage, for health/metrics endpoints. */
export function lanceDbSessionStats(): { sizeBytes: number; approxNumItems: number; indexCacheBytes: number; metadataCacheBytes: number } | null {
  if (!sessionState) return null;
  const { config, session } = sessionState;
  return { sizeBytes: Number(session.sizeBytes()), approxNumItems: session.approxNumItems(), indexCacheBytes: config.indexCacheBytes, metadataCacheBytes: config.metadataCacheBytes };
}
const MISSING_TABLE_TTL_MS = 5 * 60_000;
const connections = new Map<string, Promise<lancedb.Connection>>();
const tables = new Map<string, Promise<lancedb.Table>>();
const missingTables = new Map<string, number>();
/** Result columns present in each open table (legacy tables lack chunkIndex). */
const selectedColumns = new WeakMap<lancedb.Table, Promise<string[]>>();

function resultColumns(table: lancedb.Table): Promise<string[]> {
  let columns = selectedColumns.get(table);
  if (!columns) {
    columns = table.schema().then((schema) => {
      const names = new Set(schema.fields.map((field) => field.name));
      return [...["id", "documentId", "chunkIndex"].filter((name) => names.has(name)), "_distance"];
    });
    selectedColumns.set(table, columns);
  }
  return columns;
}

/** Hydration columns a native search reads (see @docslurp/shared/lancedb-hydration). */
const HYDRATION_RESULT_COLUMNS = ["text", ...LANCE_HYDRATION_COLUMNS] as const;

export interface LanceTableCapabilities {
  /** The table carries runId, pageNumber and hydration (rows may still hold nulls). */
  hydrationColumns: boolean;
  /** A native FTS (BM25) index covers `text`; rows added since are flat-scanned. */
  fullTextIndex: boolean;
  columns: string[];
}

/** listIndices reads the manifest; refreshed at most this often per open table. */
const CAPABILITY_TTL_MS = 60_000;
const capabilityCache = new WeakMap<lancedb.Table, { at: number; value: Promise<LanceTableCapabilities> }>();

export function lanceTableCapabilities(table: lancedb.Table, now = Date.now()): Promise<LanceTableCapabilities> {
  const cached = capabilityCache.get(table);
  if (cached && now - cached.at < CAPABILITY_TTL_MS) return cached.value;
  const value = Promise.all([table.schema(), table.listIndices()]).then(([schema, indices]) => {
    const names = schema.fields.map((field) => field.name);
    const present = new Set(names);
    return {
      columns: names,
      hydrationColumns: HYDRATION_RESULT_COLUMNS.every((name) => present.has(name)),
      fullTextIndex: indices.some((index) => index.columns.includes("text") && /fts|inverted/i.test(index.indexType ?? "")),
    };
  });
  value.catch(() => capabilityCache.delete(table));
  capabilityCache.set(table, { at: now, value });
  return value;
}

function nativeColumns(capabilities: LanceTableCapabilities, score: "_distance" | "_score"): string[] {
  const present = new Set(capabilities.columns);
  return [...["id", "documentId", "chunkIndex", ...HYDRATION_RESULT_COLUMNS].filter((name) => present.has(name)), score];
}

function documentIdFilter(documentIds: string[] | undefined): string | null {
  if (!documentIds?.length) return null;
  const literals = [...new Set(documentIds)].map(id => `'${id.replace(/'/g, "''")}'`);
  return `"documentId" IN (${literals.join(", ")})`;
}

/** SQL for a page range over the `pageNumber` column; null without bounds. */
export function lancePageRangeFilter(range: { from?: number; to?: number } | undefined): string | null {
  const parts: string[] = [];
  if (range?.from !== undefined && Number.isFinite(range.from)) parts.push(`"pageNumber" >= ${Number(range.from)}`);
  if (range?.to !== undefined && Number.isFinite(range.to)) parts.push(`"pageNumber" <= ${Number(range.to)}`);
  return parts.length ? parts.join(" AND ") : null;
}

function andFilters(...filters: Array<string | null | undefined>): string | null {
  const present = filters.filter((filter): filter is string => Boolean(filter));
  return present.length ? present.map((filter) => `(${filter})`).join(" AND ") : null;
}

function connectionKey(uri: string): string {
  const { storageOptions } = resolveLanceDbConfig();
  return `${uri}\u0000${JSON.stringify(storageOptions ?? null)}`;
}

function getDb(uri: string): Promise<lancedb.Connection> {
  const key = connectionKey(uri);
  let connection = connections.get(key);
  if (!connection) {
    connection = lanceSpan("connect", async () => {
      // LANCEDB_S3_TRACE=1 or LANCEDB_S3_CACHE_DIR routes Lance's native S3 requests through the local proxy (tracing, disk cache).
      const config = resolveLanceDbConfig();
      const traced = await withLanceS3Proxy(uri, config.storageOptions);
      // s3+ddb:// roots commit through DynamoDB; withLanceDdb adds ?ddbTableName= and the credential-splitting proxy.
      const { uri: connectUri, storageOptions } = await withLanceDdb(uri, traced, config);
      const { config: sessionConfig, session } = lanceSession();
      return lancedb.connect(connectUri, { readConsistencyInterval: sessionConfig.readConsistencySeconds, ...(storageOptions ? { storageOptions } : {}) }, session);
    });
    connection.catch(() => connections.delete(key));
    connections.set(key, connection);
  }
  return connection;
}

/** LanceDB's error for a table that does not exist (as opposed to a storage or network failure). */
export function isLanceTableNotFound(error: unknown): boolean {
  return /Table '[^']*' was not found|table .* does not exist/i.test(error instanceof Error ? error.message : String(error));
}

async function getTable(uri: string, name: string): Promise<lancedb.Table | null> {
  return (await openTarget(uri, name)).table;
}

/**
 * Open a table: `table` null with `failed` false when it does not exist
 * (cached for MISSING_TABLE_TTL_MS), `failed` true when opening it failed for
 * another reason (not cached; the next search retries).
 */
async function openTarget(uri: string, name: string): Promise<{ table: lancedb.Table | null; failed: boolean }> {
  const key = `${connectionKey(uri)}\u0000${name}`;
  const missingUntil = missingTables.get(key);
  if (missingUntil && missingUntil > Date.now()) return { table: null, failed: false };
  let table = tables.get(key);
  if (!table) {
    table = getDb(uri).then(async (db) => {
      const opened = await lanceSpan("openTable", () => db.openTable(name));
      const { config } = lanceSession();
      if (config.prewarmIndex || config.prewarmData) {
        lastPrewarm.set(key, Date.now());
        const warming = prewarmTable(opened, name, config);
        // Background by default: the first query reads from storage as it would without prewarm.
        if (config.prewarmBlocking) await warming;
      }
      return opened;
    });
    tables.set(key, table);
  }
  try {
    const opened = await table;
    refreshPrewarm(key, name, opened);
    return { table: opened, failed: false };
  } catch (error) {
    if (tables.get(key) === table) tables.delete(key);
    if (isLanceTableNotFound(error)) {
      missingTables.set(key, Date.now() + MISSING_TABLE_TTL_MS);
      return { table: null, failed: false };
    }
    console.warn(`[search] lancedb openTable failed table=${name}: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
    return { table: null, failed: true };
  }
}

/** Re-prewarm periodically: the worker rebuilds indexes in another process, which this cache has not seen. */
function refreshPrewarm(key: string, name: string, table: lancedb.Table): void {
  const { config } = lanceSession();
  if (!config.prewarmIndex || config.prewarmRefreshSeconds <= 0 || Date.now() - (lastPrewarm.get(key) ?? 0) < config.prewarmRefreshSeconds * 1_000) return;
  lastPrewarm.set(key, Date.now());
  void prewarmTable(table, name, { prewarmIndex: true, prewarmData: false });
}

function dropTable(uri: string, name: string): void {
  const key = `${connectionKey(uri)}\u0000${name}`;
  const table = tables.get(key);
  tables.delete(key);
  lastPrewarm.delete(key);
  void table?.then((handle) => handle.close()).catch(() => undefined);
}

export function resetLanceDbConnectionForTests(): void {
  for (const table of tables.values()) void table.then((handle) => handle.close()).catch(() => undefined);
  for (const connection of connections.values()) void connection.then((db) => db.close()).catch(() => undefined);
  tables.clear();
  connections.clear();
  missingTables.clear();
  lastPrewarm.clear();
  if (sessionState) clearInterval(sessionState.timer);
  sessionState = undefined;
}

export interface LanceDbSearchHit {
  id: string;
  documentId: string;
  /** Position within the document; maps a hit on a dedup source to the copy's chunk. */
  chunkIndex: number | null;
  score: number;
  /** Native searches (`hydrate`): the row's text and hydration columns, when the table has them. */
  text?: string | null;
  runId?: string | null;
  pageNumber?: number | null;
  hydration?: string | null;
}

type LanceDbRow = {
  id: string;
  documentId: string;
  chunkIndex?: number | null;
  _distance: number;
  _score?: number;
  text?: string | null;
  runId?: string | null;
  pageNumber?: number | null;
  hydration?: string | null;
};

function hydratedFields(row: LanceDbRow): Pick<LanceDbSearchHit, "text" | "runId" | "pageNumber" | "hydration"> {
  return {
    ...(row.text !== undefined ? { text: row.text } : {}),
    ...(row.runId !== undefined ? { runId: row.runId } : {}),
    ...(row.pageNumber !== undefined ? { pageNumber: row.pageNumber } : {}),
    ...(row.hydration !== undefined ? { hydration: row.hydration } : {}),
  };
}

interface LanceTarget { uri: string; name: string; documentIds?: string[] }

/** The exact tables a search may read for this org and embedding space; never a prefix scan. */
function searchTargets(args: { orgId: string; embeddingModel?: string; dimension: number; documentIds?: string[]; legacyDocumentIds?: string[] }): LanceTarget[] {
  const { root } = resolveLanceDbConfig();
  const targets: LanceTarget[] = [];
  if (args.embeddingModel) {
    const location = VectorNamespaceManager.getEmbeddingLocation(root, args.orgId, args.embeddingModel, args.dimension);
    targets.push({ uri: location.uri, name: location.table, documentIds: args.documentIds });
    targets.push({ uri: root, name: VectorNamespaceManager.getEmbeddingTableName(args.orgId, args.embeddingModel, args.dimension), documentIds: args.documentIds });
    if (args.legacyDocumentIds?.length) {
      targets.push({ uri: root, name: VectorNamespaceManager.getTableName(args.orgId), documentIds: args.legacyDocumentIds });
    }
  } else {
    targets.push({ uri: root, name: VectorNamespaceManager.getTableName(args.orgId), documentIds: args.documentIds });
  }
  return targets;
}

function documentIdSet(documentIds?: string[]): Set<string> | null {
  if (!documentIds || documentIds.length === 0) {
    return null;
  }
  return new Set(documentIds);
}

export function filterLanceDbRowsByDocumentIds(
  rows: LanceDbRow[],
  documentIds?: string[],
): LanceDbRow[] {
  const allowedDocumentIds = documentIdSet(documentIds);
  if (!allowedDocumentIds) {
    return rows;
  }
  return rows.filter((row) => allowedDocumentIds.has(row.documentId));
}

/**
 * Search the exact LanceDB table for a given organization.
 *
 * The table name is derived from the authoritative org id resolved from
 * workspace access. Callers cannot provide a namespace or table prefix, so a
 * malformed/missing namespace cannot widen the ANN scan to another tenant.
 */
export async function lanceDbVectorSearch(args: {
  orgId: string;
  embeddingModel?: string;
  /** Only documents whose persisted index matches the query model/dimension. */
  legacyDocumentIds?: string[];
  queryVector: number[];
  documentIds?: string[];
  limit: number;
  /** strict-privacy never reads or writes the result cache. */
  privacyMode?: PrivacyMode;
  /** Also return text and hydration columns (native search) where the table has them. */
  hydrate?: boolean;
  /** Extra Lance SQL filter, e.g. a page range; only applied to tables with hydration columns. */
  where?: string | null;
}): Promise<LanceDbSearchHit[]> {
  if (!args.orgId.trim()) {
    return [];
  }

  const refineFactor = process.env.LANCEDB_REFINE_FACTOR;
  // Validate outside the native-query catch: configuration errors must be visible.
  lanceDbQueryTuning(args.limit, 0, refineFactor);

  // Read per search so tests and config reloads see the current LANCEDB_URI.
  // Exact previous layouts only; no prefix scans or cross-tenant discovery.
  const targets = searchTargets({ ...args, dimension: args.queryVector.length });
  const variant = args.hydrate || args.where ? JSON.stringify([args.hydrate ?? false, args.where ?? null]) : undefined;
  const opened = await Promise.all(targets.map(async (target) => ({ ...target, table: await getTable(target.uri, target.name) })));

  // Result cache (off unless SEARCH_RESULT_CACHE_MAX_ENTRIES > 0). The key holds each
  // table's version, so any write produces a new key. table.version() reads the open
  // handle's dataset, which refreshes at most every READ_CONSISTENCY_SECONDS, exactly
  // like a query on that handle, so it adds no storage round trip of its own.
  const cache = resultCache<LanceDbSearchHit[]>();
  let cacheKey: string | null = null;
  const bypassReason = args.privacyMode === "strict-privacy" ? "strict-privacy" : null;
  if (cache.enabled && bypassReason) {
    startDependencySpan("lancedb.result_cache", {
      "db.system.name": "lancedb", "docslurp.dependency.type": "cache", "docslurp.dependency.provider": "memory",
      "docslurp.dependency.operation": "result_cache", "docslurp.dependency.phase": "adapter",
      "docslurp.cache.hit": false, "docslurp.cache.bypassed": true, "docslurp.cache.bypass_reason": bypassReason,
      "docslurp.privacy.mode": args.privacyMode,
    }).end();
    countSearchEvent("resultCacheBypass");
  } else if (cache.enabled) {
    try {
      const present = opened.filter((target): target is typeof target & { table: lancedb.Table } => target.table !== null);
      const versions = await Promise.all(present.map((target) => target.table.version()));
      cacheKey = resultCacheKey({
        orgId: args.orgId,
        targets: present.map((target, index) => ({ uri: target.uri, name: target.name, version: versions[index]!, documentIds: target.documentIds })),
        queryVector: args.queryVector,
        limit: args.limit,
        refineFactor: refineFactor ?? undefined,
        embeddingModel: args.embeddingModel,
        tuning: present.map((target) => lanceDbQueryTuning(args.limit, target.documentIds?.length ?? 0, refineFactor)),
        variant,
      });
      const cached = cache.get(cacheKey);
      const span = startDependencySpan("lancedb.result_cache", {
        "db.system.name": "lancedb", "docslurp.dependency.type": "cache", "docslurp.dependency.provider": "memory",
        "docslurp.dependency.operation": "result_cache", "docslurp.dependency.phase": "adapter",
        "docslurp.cache.hit": cached !== undefined, "docslurp.cache.bypassed": false, "docslurp.cache.entries": cache.size,
        ...(args.privacyMode ? { "docslurp.privacy.mode": args.privacyMode } : {}),
      });
      span.end();
      if (cached) {
        countSearchEvent("resultCacheHit");
        console.info(`[search-cache] result hit hits=${cached.length} entries=${cache.size}`);
        return cached.map((hit) => ({ ...hit }));
      }
      countSearchEvent("resultCacheMiss");
    } catch {
      cacheKey = null; // A version lookup failure falls through to an uncached search.
    }
  }

  let failed = false;
  const rows = (await Promise.all(opened.map(async ({ uri, name, documentIds, table }) => {
    if (!table) return [];
    try {
      // Filter before nearest-neighbor selection. Overfetching a global top-k
      // and filtering afterward can miss every scoped document when another
      // workspace occupies the first 1,000 neighbors in this org's table.
      const capabilities = args.hydrate || args.where ? await lanceTableCapabilities(table) : null;
      // A page filter needs the pageNumber column; a table without it cannot honor the filter.
      if (args.where && !capabilities?.hydrationColumns) return [];
      const query = table.vectorSearch(args.queryVector).column("vector")
        .select(capabilities && args.hydrate ? nativeColumns(capabilities, "_distance") : await resultColumns(table)).limit(args.limit);
      const filter = andFilters(documentIdFilter(documentIds), args.where);
      if (filter) query.where(filter);
      const tuning = lanceDbQueryTuning(args.limit, documentIds?.length ?? 0, refineFactor);
      if (tuning.ef !== undefined) query.ef(tuning.ef);
      if (tuning.refineFactor !== undefined) query.refineFactor(tuning.refineFactor);
      // Retain an independent scope check at the storage boundary.
      return filterLanceDbRowsByDocumentIds((await lanceSpan("search", () => query.toArray())) as LanceDbRow[], documentIds);
    } catch {
      failed = true;
      dropTable(uri, name);
      return [];
    }
  }))).flat();

  rows.sort((a, b) => (a._distance ?? Infinity) - (b._distance ?? Infinity));

  // Deduplicate by id and limit
  const seen = new Set<string>();
  const results: LanceDbSearchHit[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    results.push({
      id: row.id,
      documentId: row.documentId,
      chunkIndex: typeof row.chunkIndex === "number" ? row.chunkIndex : null,
      score: 1 / (1 + (row._distance ?? 0)),
      ...hydratedFields(row),
    });
    if (results.length >= args.limit) break;
  }

  // Never cache a degraded answer from a target that errored.
  if (cacheKey && !failed) cache.set(cacheKey, results.map((hit) => ({ ...hit })));
  return results;
}

/** Why a native keyword search handed over to Postgres FTS. */
export type LanceFtsFallbackReason = "open-failed" | "no-table" | "no-fts-index" | "no-hydration-columns";

/**
 * BM25 full-text search over the chunk `text` column with LanceDB's native
 * FTS index, filtered to the eligible documents before ranking (like the
 * vector prefilter), so the top `limit` are exact BM25 top-k over the whole
 * scope rather than a sample. Returns `indexed: false` when an existing
 * target table has no FTS index yet: the caller then uses Postgres FTS.
 */
export async function lanceDbFullTextSearch(args: {
  orgId: string;
  embeddingModel: string;
  dimension: number;
  query: string;
  documentIds: string[];
  legacyDocumentIds?: string[];
  limit: number;
  where?: string | null;
}): Promise<{ indexed: boolean; hits: LanceDbSearchHit[]; fallback?: LanceFtsFallbackReason; table?: string }> {
  if (!args.orgId.trim() || !args.query.trim() || args.documentIds.length === 0) return { indexed: true, hits: [] };
  const targets = searchTargets(args);
  const states = await Promise.all(targets.map(async (target) => ({ ...target, ...await openTarget(target.uri, target.name) })));
  const failed = states.find((target) => target.failed);
  // A table that failed to open may hold the documents' rows: let Postgres FTS answer.
  if (failed) return { indexed: false, hits: [], fallback: "open-failed", table: failed.name };
  const opened = states.filter((target): target is typeof target & { table: lancedb.Table } => target.table !== null);
  // Callers pass vector-ready documents, so their rows should exist somewhere: no table means Postgres.
  if (opened.length === 0) return { indexed: false, hits: [], fallback: "no-table" };
  const capabilities = await Promise.all(opened.map((target) => lanceTableCapabilities(target.table).catch(() => null)));
  const unindexed = capabilities.findIndex((caps) => !caps?.fullTextIndex);
  if (unindexed >= 0) return { indexed: false, hits: [], fallback: "no-fts-index", table: opened[unindexed]!.name };
  const unhydrated = capabilities.findIndex((caps) => args.where && !caps!.hydrationColumns);
  if (unhydrated >= 0) return { indexed: false, hits: [], fallback: "no-hydration-columns", table: opened[unhydrated]!.name };
  // A failing query throws to the caller (Postgres FTS answers); the shared table handle stays open.
  const rows = (await Promise.all(opened.map(async ({ documentIds, table }, index) => {
    const caps = capabilities[index]!;
    const query = table.query().fullTextSearch(args.query, { columns: "text" })
      .select(nativeColumns(caps, "_score")).limit(args.limit);
    const filter = andFilters(documentIdFilter(documentIds), args.where);
    if (filter) query.where(filter);
    return filterLanceDbRowsByDocumentIds((await lanceSpan("fts", () => query.toArray())) as LanceDbRow[], documentIds);
  }))).flat();
  rows.sort((a, b) => (b._score ?? 0) - (a._score ?? 0));
  const seen = new Set<string>();
  const hits: LanceDbSearchHit[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    hits.push({ id: row.id, documentId: row.documentId, chunkIndex: typeof row.chunkIndex === "number" ? row.chunkIndex : null,
      score: row._score ?? 0, ...hydratedFields(row) });
    if (hits.length >= args.limit) break;
  }
  return { indexed: true, hits };
}

export function getOrgLanceDbPrefix(orgId: string): string {
  return VectorNamespaceManager.getTableName(orgId);
}

function lanceSpan<T>(operation: string, run: () => Promise<T>): Promise<T> {
  const attributes = { "db.system.name": "lancedb",
    "docslurp.dependency.type": "vector", "docslurp.dependency.provider": "lancedb",
    "docslurp.dependency.operation": operation, "docslurp.dependency.phase": "adapter" };
  // Searches also report their own S3 request counts by object class (non-zero only with LANCEDB_S3_TRACE).
  return operation === "search" ? withLanceSearchSpan(`lancedb.${operation}`, attributes, run) : withDependencySpan(`lancedb.${operation}`, attributes, run);
}
