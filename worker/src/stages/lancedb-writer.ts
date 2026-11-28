import { Index, makeArrowTable, type Table } from "@lancedb/lancedb";
import { LANCE_HYDRATION_COLUMN_SPECS } from "@docslurp/shared/lancedb-hydration";

import { connectLanceDb } from "./lancedb-connection.js";
import { setTimeout as delay } from "node:timers/promises";
import type { VectorBackendRecord } from "./embedding-runtime.js";
import {
  ensureChunkTextFtsIndex,
  lanceDbFtsIndexEnabled,
  lanceDbMaintenanceDue,
  lanceMaintenanceKey,
  requestLanceDbMaintenance,
  scheduleLanceDbMaintenance,
  type LanceDbCadencePolicy,
  type LanceDbMaintenanceMode,
  type LanceDbMaintenanceOptions,
} from "./lancedb-maintenance.js";

/**
 * Lance commit conflicts, and transient object-storage or network failures,
 * that a later attempt can succeed past.
 */
const RETRYABLE_COMMIT_ERROR =
  /incompatible transaction|commit conflict|too many concurrent writ|retryable|please retry|concurrent modification|LanceDB write attempt timed out|ECONNRESET|ETIMEDOUT|EPIPE|socket hang up|SlowDown|503 Service Unavailable|InternalError|RequestTimeout/i;

export function isRetryableLanceCommitError(error: unknown): boolean {
  return RETRYABLE_COMMIT_ERROR.test(error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error));
}

export type LanceWriteRetryOptions = {
  /** Attempts after the first one (each attempt already includes Lance's own conflict retries). */
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** One attempt (create/open/merge) may take this long before it is abandoned and retried. */
  attemptTimeoutMs?: number;
};

/** LANCEDB_WRITE_ATTEMPT_TIMEOUT_MS, default 120 s: object-storage commits are slow but not unbounded. */
export function lanceWriteAttemptTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.LANCEDB_WRITE_ATTEMPT_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

/**
 * Writers in one process take turns per table. Concurrent activities and
 * documents in the same worker otherwise collide on Lance commits and spend
 * their retries on conflicts with each other; other machines still conflict
 * and retry, which is what the retry loop is for.
 */
const tableQueues = new Map<string, Promise<unknown>>();

async function inTableQueue<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = tableQueues.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const settled = run.then(() => undefined, () => undefined);
  tableQueues.set(key, settled);
  try {
    return await run;
  } finally {
    if (tableQueues.get(key) === settled) tableQueues.delete(key);
  }
}

async function withAttemptTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`LanceDB write attempt timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Upsert records keyed by chunk id with the installed Node client (lean workers need no
 * Python). Safe to replay: a retried or duplicated write converges on one row per id.
 */
export async function writeLanceDbRecords(
  uri: string,
  collection: string,
  records: VectorBackendRecord[],
  signal?: AbortSignal,
  retry: LanceWriteRetryOptions = {},
): Promise<void> {
  signal?.throwIfAborted();
  if (records.length === 0) return;
  await inTableQueue(`${uri}\u0000${collection}`, () => writeLanceDbRecordsNow(uri, collection, records, signal, retry));
}

/** A chunk row without its vector: what keyword search needs, written before the document is embedded. */
export type LanceTextRecord = Omit<VectorBackendRecord, "vector">;

/** Rows sampled to infer a new table's schema; one document's rows share one shape. */
const TEXT_SCHEMA_SAMPLE_ROWS = 64;

/**
 * Upsert chunk rows without vectors, keyed by chunk id. A matched row keeps the vector it has (the source carries
 * no `vector` column) and a new row gets a null one, which vector search and vector index builds skip; the index
 * stage's upsert of the same ids fills it. `dimensions` is the table's embedding space: a table created here gets
 * the schema a vector write would have inferred, and its full-text index, so the rows are searchable at once.
 */
export async function writeLanceDbTextRecords(
  uri: string,
  collection: string,
  records: LanceTextRecord[],
  dimensions: number,
  signal?: AbortSignal,
  retry: LanceWriteRetryOptions = {},
): Promise<void> {
  signal?.throwIfAborted();
  if (records.length === 0) return;
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) throw new Error("LanceDB text rows require the table's vector dimensions");
  const rows = records.map((record) => {
    const { vector: _vector, ...rest } = record as LanceTextRecord & { vector?: unknown };
    return rest;
  });
  await inTableQueue(`${uri}\u0000${collection}`, () =>
    writeLanceDbRecordsNow(uri, collection, rows as unknown as VectorBackendRecord[], signal, retry, dimensions));
}

async function writeLanceDbRecordsNow(
  uri: string,
  collection: string,
  records: VectorBackendRecord[],
  signal: AbortSignal | undefined,
  retry: LanceWriteRetryOptions,
  /** Set for rows without vectors: the dimensions a table created by this write declares for its vector column. */
  textOnlyDimensions?: number,
): Promise<void> {
  signal?.throwIfAborted();
  const retries = retry.retries ?? 10;
  const baseDelayMs = retry.baseDelayMs ?? 200;
  const maxDelayMs = retry.maxDelayMs ?? 15_000;
  const attemptTimeoutMs = retry.attemptTimeoutMs ?? lanceWriteAttemptTimeoutMs();
  const db = await connectLanceDb(uri);
  try {
    const rows = withUniformHydrationColumns(records) as unknown as Array<Record<string, unknown>>;
    const hydrated = rows.some((row) => row.hydration !== undefined);
    for (let attempt = 0; ; attempt += 1) {
      signal?.throwIfAborted();
      let initializingTable = true;
      try {
        if (!(await withAttemptTimeout(db.tableNames(), attemptTimeoutMs)).includes(collection)) {
          // existOk can publish a replacement after another first writer has
          // already upserted. Strict creation makes the loser retry against the
          // winner's table instead of resetting its rows.
          if (textOnlyDimensions === undefined) {
            (await withAttemptTimeout(db.createTable(collection, rows), attemptTimeoutMs)).close();
          } else {
            // Rows without vectors cannot type the vector column: infer the schema from a sample carrying a
            // placeholder vector, create the table empty, and let the upsert below insert the real rows.
            const placeholder = new Array<number>(textOnlyDimensions).fill(0);
            const { schema } = makeArrowTable(rows.slice(0, TEXT_SCHEMA_SAMPLE_ROWS).map((row) => ({ ...row, vector: placeholder })));
            const created = await withAttemptTimeout(db.createEmptyTable(collection, schema), attemptTimeoutMs);
            try {
              // Best effort: without it keyword search waits for the table's first maintenance pass.
              if (lanceDbFtsIndexEnabled()) {
                const fts = await withAttemptTimeout(
                  ensureChunkTextFtsIndex(created, [], { key: lanceMaintenanceKey(uri, collection) }), attemptTimeoutMs,
                ).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
                if ("error" in fts && fts.error) console.warn(`[lancedb] fts index on new table ${collection} failed: ${fts.error.split("\n")[0]}`);
              }
            } finally {
              created.close();
            }
          }
        }
        const table = await withAttemptTimeout(db.openTable(collection), attemptTimeoutMs);
        initializingTable = false;
        try {
          // This adapter owns precomputed vectors. Persisted provider configuration
          // must never instantiate code or clients in the credential-bearing worker.
          if ((await withAttemptTimeout(table.schema(), attemptTimeoutMs)).metadata.has("embedding_functions")) {
            throw new Error("LanceDB worker refuses persisted embedding_functions metadata");
          }
          if (hydrated) await withAttemptTimeout(ensureLanceHydrationColumns(table), attemptTimeoutMs);
          await withAttemptTimeout(
            table.mergeInsert("id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows),
            attemptTimeoutMs,
          );
        } finally {
          table.close();
        }
        return;
      } catch (error) {
        // A concurrent first writer can publish the table directory before its
        // initial version is readable, or win creation after our tableNames check.
        // Retry only during initialization; missing data during upsert is not
        // evidence of this race. The same retry limit and abort signal apply.
        const initializationRace = initializingTable
          && /Table ['"].+['"] was not found|Dataset at path .+ was not found|Table (?:['"].+['"]|\S+) already exists/i.test(
            error instanceof Error ? error.message : String(error),
          );
        if (attempt >= retries || (!initializationRace && !isRetryableLanceCommitError(error))) throw error;
        // Full jitter: colliding writers spread out instead of retrying in lockstep.
        const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
        await delay(Math.round(cap / 2 + Math.random() * (cap / 2)), undefined, { signal });
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Makes a BTREE scalar index exist on `column`, in this process's turn for the table. For a column every query
 * filters by: the chunks table gets its `documentId` index from maintenance once it is large enough to matter
 * (lancedb-maintenance.ts); a table whose every read is `documentId IN (...)` asks for it from its first write.
 * Rows written later are folded in by `optimize()`. Returns true when this call built the index. A missing table
 * is nothing to index.
 */
export async function ensureLanceScalarIndex(
  uri: string,
  collection: string,
  column: string,
  retry: LanceWriteRetryOptions = {},
): Promise<boolean> {
  const retries = retry.retries ?? 10;
  const baseDelayMs = retry.baseDelayMs ?? 200;
  const maxDelayMs = retry.maxDelayMs ?? 15_000;
  const attemptTimeoutMs = retry.attemptTimeoutMs ?? lanceWriteAttemptTimeoutMs();
  return await inTableQueue(`${uri}\u0000${collection}`, async () => {
    const db = await connectLanceDb(uri);
    try {
      if (!(await withAttemptTimeout(db.tableNames(), attemptTimeoutMs)).includes(collection)) return false;
      for (let attempt = 0; ; attempt += 1) {
        try {
          const table = await withAttemptTimeout(db.openTable(collection), attemptTimeoutMs);
          try {
            if ((await withAttemptTimeout(table.listIndices(), attemptTimeoutMs)).some((index) => index.columns.includes(column))) return false;
            // replace=false: a concurrent writer that already built the index wins.
            await withAttemptTimeout(table.createIndex(column, { config: Index.btree(), replace: false }), attemptTimeoutMs);
            return true;
          } finally {
            table.close();
          }
        } catch (error) {
          // Lost the race to another machine: the index exists.
          if (/already exists/i.test(error instanceof Error ? error.message : String(error))) return false;
          if (attempt >= retries || !isRetryableLanceCommitError(error)) throw error;
          const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
          await delay(Math.round(cap / 2 + Math.random() * (cap / 2)));
        }
      }
    } finally {
      db.close();
    }
  });
}

/**
 * Delete rows by chunk id, in this process's turn for the table (see
 * inTableQueue). For rows whose chunk is gone: search serves hydrated rows
 * without re-reading Postgres, so a row must not outlive its chunk.
 */
export async function deleteLanceDbRecords(
  uri: string,
  collection: string,
  ids: readonly string[],
  retry: LanceWriteRetryOptions = {},
): Promise<void> {
  if (ids.length === 0) return;
  const retries = retry.retries ?? 10;
  const baseDelayMs = retry.baseDelayMs ?? 200;
  const maxDelayMs = retry.maxDelayMs ?? 15_000;
  const attemptTimeoutMs = retry.attemptTimeoutMs ?? lanceWriteAttemptTimeoutMs();
  await inTableQueue(`${uri}\u0000${collection}`, async () => {
    const db = await connectLanceDb(uri);
    try {
      if (!(await withAttemptTimeout(db.tableNames(), attemptTimeoutMs)).includes(collection)) return;
      for (let index = 0; index < ids.length; index += 500) {
        const list = ids.slice(index, index + 500).map((id) => `'${id.replace(/'/g, "''")}'`).join(", ");
        // Other machines commit to the same table: retry conflicts like writes do.
        for (let attempt = 0; ; attempt += 1) {
          try {
            const table = await withAttemptTimeout(db.openTable(collection), attemptTimeoutMs);
            try {
              await withAttemptTimeout(table.delete(`id IN (${list})`), attemptTimeoutMs);
            } finally {
              table.close();
            }
            break;
          } catch (error) {
            if (attempt >= retries || !isRetryableLanceCommitError(error)) throw error;
            const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
            await delay(Math.round(cap / 2 + Math.random() * (cap / 2)));
          }
        }
      }
    } finally {
      db.close();
    }
  });
}

/**
 * A merge-insert source needs one schema. Rows without a run id (legacy outbox
 * rows) get empty hydration values when they share a batch with hydrated rows;
 * search hydrates those from Postgres.
 */
export function withUniformHydrationColumns<T extends LanceTextRecord>(records: T[]): T[] {
  const hydrated = records.some((record) => record.hydration !== undefined);
  return records.map((record) => hydrated && record.hydration === undefined
    ? { ...record, runId: "", pageNumber: 0, hydration: "" }
    : { ...record });
}

/**
 * Tables created before the hydration columns existed get them as nullable
 * columns (existing rows read null until lancedb-native-backfill fills them).
 * Nullable, so a worker still running the previous release can keep inserting
 * rows without them.
 */
export async function ensureLanceHydrationColumns(table: Pick<Table, "schema" | "addColumns">): Promise<boolean> {
  const names = new Set((await table.schema()).fields.map((field) => field.name));
  const missing = LANCE_HYDRATION_COLUMN_SPECS.filter((column) => !names.has(column.name));
  if (missing.length === 0) return false;
  try {
    await table.addColumns(missing.map((column) => ({ name: column.name, valueSql: column.valueSql })));
  } catch (error) {
    // A concurrent writer added them first.
    if (!/already exists|duplicate/i.test(error instanceof Error ? error.message : String(error))) throw error;
  }
  return true;
}

/**
 * Group items into windows covering at most `pagesPerWindow` pages, bucketed by page
 * number (pages 1..N, N+1..2N, ...). Items without page info join the most recent window.
 * Windows come back in page order; item order is preserved within each window.
 */
export function planPageWindows<T>(
  items: T[],
  pageOf: (item: T) => number | null,
  pagesPerWindow: number,
): T[][] {
  const size = Math.max(1, Math.floor(pagesPerWindow));
  const buckets = new Map<number, T[]>();
  let current: number | null = null;
  for (const item of items) {
    const page = pageOf(item);
    if (page !== null) current = Math.floor((Math.max(1, page) - 1) / size);
    const key = current ?? 0;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }
  return [...buckets.entries()].sort(([a], [b]) => a - b).map(([, bucket]) => bucket);
}

/** First page a chunk touches, from `pageNumber` or the smallest of `pageNumbers`. */
export function chunkFirstPage(chunk: { pageNumber?: number | null; pageNumbers?: number[] }): number | null {
  if (typeof chunk.pageNumber === "number" && Number.isFinite(chunk.pageNumber)) return chunk.pageNumber;
  const pages = (chunk.pageNumbers ?? []).filter((page) => Number.isFinite(page));
  return pages.length > 0 ? Math.min(...pages) : null;
}

export type LanceDbDocumentWriteDeps = {
  write: typeof writeLanceDbRecords;
  /** Inline mode: run maintenance and wait for it. */
  maintain: typeof requestLanceDbMaintenance;
  /** Background mode: hand maintenance to the process pool without waiting. */
  schedule: typeof scheduleLanceDbMaintenance;
};

/**
 * Direct mode's cadence counters, per table, in memory (direct mode has no worker database
 * to keep them in). Counters reset when maintenance is requested, so a burst of windows
 * yields one run instead of one per window.
 */
export class DirectMaintenanceCadence {
  private readonly tables = new Map<string, { rowsSince: number; commitsSince: number; lastOptimizedAt: number | null }>();

  /** Count one committed window; returns true (and resets) when maintenance is due. */
  recordWrite(key: string, rows: number, policy: LanceDbCadencePolicy, now = Date.now()): boolean {
    const counters = this.tables.get(key) ?? { rowsSince: 0, commitsSince: 0, lastOptimizedAt: null };
    counters.rowsSince += rows;
    counters.commitsSince += 1;
    this.tables.set(key, counters);
    if (!lanceDbMaintenanceDue(counters, policy, now)) return false;
    counters.rowsSince = 0;
    counters.commitsSince = 0;
    counters.lastOptimizedAt = now;
    return true;
  }
}

const directCadence = new DirectMaintenanceCadence();

/**
 * Write one document's records window by window. Background (default): after each window the
 * cadence policy decides whether the table is due for maintenance (optimize + index refresh +
 * cleanup) and due runs go to the process maintenance pool. Inline: every window is followed
 * by awaited maintenance, as before the cadence policy.
 */
export async function writeLanceDbDocumentInWindows(args: {
  uri: string;
  table: string;
  windows: VectorBackendRecord[][];
  maintenance: LanceDbMaintenanceOptions & { enabled: boolean; mode?: LanceDbMaintenanceMode; cadence: LanceDbCadencePolicy };
  signal?: AbortSignal;
  deps?: Partial<LanceDbDocumentWriteDeps>;
  cadence?: DirectMaintenanceCadence;
}): Promise<{ writes: number; maintenanceRuns: number }> {
  const write = args.deps?.write ?? writeLanceDbRecords;
  const maintain = args.deps?.maintain ?? requestLanceDbMaintenance;
  const schedule = args.deps?.schedule ?? scheduleLanceDbMaintenance;
  const cadence = args.cadence ?? directCadence;
  const key = `${args.uri}\u0000${args.table}`;
  const options: LanceDbMaintenanceOptions = {
    vectorIndexMinRows: args.maintenance.vectorIndexMinRows,
    versionRetentionMs: args.maintenance.versionRetentionMs,
    maxIndexSegments: args.maintenance.maxIndexSegments,
    consolidateMaxRows: args.maintenance.consolidateMaxRows,
  };
  // Preserve single-write behavior for documents without records.
  const windows = args.windows.length > 0 ? args.windows : [[]];
  let maintenanceRuns = 0;
  for (const window of windows) {
    await write(args.uri, args.table, window, args.signal);
    if (!args.maintenance.enabled) continue;
    if (args.maintenance.mode === "inline") {
      // The behaviour before the cadence policy: maintain after every window, awaited.
      await maintain(args.uri, args.table, options);
      maintenanceRuns += 1;
      continue;
    }
    if (window.length === 0) continue;
    if (!cadence.recordWrite(key, window.length, args.maintenance.cadence)) continue;
    if (schedule(args.uri, args.table, options)) maintenanceRuns += 1;
  }
  return { writes: windows.length, maintenanceRuns };
}
