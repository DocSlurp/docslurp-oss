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
import { withLanceDdb } from "@docslurp/shared/lancedb-ddb";
import { withLanceS3Trace, withLanceSearchSpan } from "@docslurp/shared/lancedb-s3-trace";

import { lanceDbQueryTuning } from "./lancedb-query-tuning.js";
import { resultCache, resultCacheKey } from "./result-cache.js";
import { countSearchEvent } from "./timings.js";

/**
 * Connections and table handles are reused across searches. Opening them per
 * search re-read manifests (and, on object storage, index and vector pages)
 * from S3 on every query: about two seconds per search in production.
 * - Tables check for new versions at most every READ_CONSISTENCY_SECONDS, so
 *   newly indexed rows appear within that interval.
 * - A table that does not exist yet is remembered for MISSING_TABLE_TTL_MS
 *   (5 min), so absent legacy tables don't cost S3 round trips on queries.
 * - A handle that errors is dropped and reopened on the next search.
 */
const READ_CONSISTENCY_SECONDS = 10;
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

function connectionKey(uri: string): string {
  const { storageOptions } = resolveLanceDbConfig();
  return `${uri}\u0000${JSON.stringify(storageOptions ?? null)}`;
}

function getDb(uri: string): Promise<lancedb.Connection> {
  const key = connectionKey(uri);
  let connection = connections.get(key);
  if (!connection) {
    connection = lanceSpan("connect", async () => {
      // LANCEDB_S3_TRACE=1 routes Lance's native S3 requests through the tracing proxy.
      const config = resolveLanceDbConfig();
      const traced = await withLanceS3Trace(uri, config.storageOptions);
      // s3+ddb:// roots commit through DynamoDB; withLanceDdb adds ?ddbTableName= and the credential-splitting proxy.
      const { uri: connectUri, storageOptions } = await withLanceDdb(uri, traced, config);
      return lancedb.connect(connectUri, { readConsistencyInterval: READ_CONSISTENCY_SECONDS, ...(storageOptions ? { storageOptions } : {}) });
    });
    connection.catch(() => connections.delete(key));
    connections.set(key, connection);
  }
  return connection;
}

async function getTable(uri: string, name: string): Promise<lancedb.Table | null> {
  const key = `${connectionKey(uri)}\u0000${name}`;
  const missingUntil = missingTables.get(key);
  if (missingUntil && missingUntil > Date.now()) return null;
  let table = tables.get(key);
  if (!table) {
    table = getDb(uri).then((db) => lanceSpan("openTable", () => db.openTable(name)));
    tables.set(key, table);
  }
  try {
    return await table;
  } catch {
    tables.delete(key);
    missingTables.set(key, Date.now() + MISSING_TABLE_TTL_MS);
    return null;
  }
}

function dropTable(uri: string, name: string): void {
  const key = `${connectionKey(uri)}\u0000${name}`;
  const table = tables.get(key);
  tables.delete(key);
  void table?.then((handle) => handle.close()).catch(() => undefined);
}

export function resetLanceDbConnectionForTests(): void {
  for (const table of tables.values()) void table.then((handle) => handle.close()).catch(() => undefined);
  for (const connection of connections.values()) void connection.then((db) => db.close()).catch(() => undefined);
  tables.clear();
  connections.clear();
  missingTables.clear();
}

export interface LanceDbSearchHit {
  id: string;
  documentId: string;
  /** Position within the document; maps a hit on a dedup source to the copy's chunk. */
  chunkIndex: number | null;
  score: number;
}

type LanceDbRow = {
  id: string;
  documentId: string;
  chunkIndex?: number | null;
  _distance: number;
};

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
}): Promise<LanceDbSearchHit[]> {
  if (!args.orgId.trim()) {
    return [];
  }

  const refineFactor = process.env.LANCEDB_REFINE_FACTOR;
  // Validate outside the native-query catch: configuration errors must be visible.
  lanceDbQueryTuning(args.limit, 0, refineFactor);

  // Read per search so tests and config reloads see the current LANCEDB_URI.
  const { root } = resolveLanceDbConfig();
  const targets: Array<{ uri: string; name: string; documentIds?: string[] }> = [];
  if (args.embeddingModel) {
    const location = VectorNamespaceManager.getEmbeddingLocation(root, args.orgId, args.embeddingModel, args.queryVector.length);
    targets.push({ uri: location.uri, name: location.table, documentIds: args.documentIds });
    // Exact previous layout only; no prefix scans or cross-tenant discovery.
    targets.push({ uri: root, name: VectorNamespaceManager.getEmbeddingTableName(args.orgId, args.embeddingModel, args.queryVector.length), documentIds: args.documentIds });
    if (args.legacyDocumentIds?.length) {
      targets.push({ uri: root, name: VectorNamespaceManager.getTableName(args.orgId), documentIds: args.legacyDocumentIds });
    }
  } else {
    targets.push({ uri: root, name: VectorNamespaceManager.getTableName(args.orgId), documentIds: args.documentIds });
  }
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
      const query = table.vectorSearch(args.queryVector).column("vector")
        .select(await resultColumns(table)).limit(args.limit);
      if (documentIds?.length) {
        const literals = [...new Set(documentIds)].map(id => `'${id.replace(/'/g, "''")}'`);
        query.where(`"documentId" IN (${literals.join(", ")})`);
      }
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
    });
    if (results.length >= args.limit) break;
  }

  // Never cache a degraded answer from a target that errored.
  if (cacheKey && !failed) cache.set(cacheKey, results.map((hit) => ({ ...hit })));
  return results;
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
