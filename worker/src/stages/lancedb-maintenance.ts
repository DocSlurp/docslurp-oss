import { Index, type Connection, type Table } from "@lancedb/lancedb";
import { performance } from "node:perf_hooks";
import { connectLanceDb } from "./lancedb-connection.js";
import { lanceMaintenancePool } from "./lancedb-maintenance-pool.js";

export type LanceDbMaintenanceOptions = {
  /** Build the first vector index once the table holds at least this many rows. */
  vectorIndexMinRows: number;
  /**
   * Versions older than this are deleted by optimize(). Lance's default is 7 days, which
   * keeps every pre-compaction fragment of a busy table in the bucket for a week.
   */
  versionRetentionMs?: number;
  /**
   * Every optimize() that indexes new rows appends one HNSW segment, and Lance never compacts
   * fragments that belong to different segments, so segments and fragments only grow. Past
   * this many segments the vector index is rebuilt into one (replace) and the table is
   * compacted afterwards. 0 or undefined disables consolidation.
   */
  maxIndexSegments?: number;
  /**
   * Skip consolidation above this many rows: a rebuild retrains HNSW over the whole table and
   * the following compaction rewrites every fragment. 0 or undefined means no cap.
   */
  consolidateMaxRows?: number;
};

/**
 * How documents reach a workspace table. `queued` (default): enqueue to the Postgres
 * outbox and let the table's single write-lease holder commit pending documents in one
 * batch. `direct`: every document commits its own merge-insert (optimistic, conflicts
 * under concurrency; kept as a fallback for setups without the worker database).
 */
export type LanceDbWriteMode = "queued" | "direct";

/**
 * `background` (default): the index stage returns once a document's rows are committed,
 * maintenance runs in the process maintenance pool on the cadence policy, and the vector index
 * is consolidated past maxIndexSegments. `inline`: the behaviour before 2026-10-14, exactly:
 * the stage awaits maintenance, queued mode uses the old trigger (optimizeEveryRows, default
 * 20,000, or optimizeIntervalSeconds; first run at min(rows, 1,000)), direct mode maintains after
 * every window, and there is no consolidation. The new cadence knobs do not apply in inline mode.
 */
export type LanceDbMaintenanceMode = "background" | "inline";

/** When a table is due for optimize() (index refresh + compaction + cleanup). */
export type LanceDbCadencePolicy = {
  /** Due once this many rows were written since the last optimize (unindexed tail size)... */
  optimizeEveryRows: number;
  /** ...or this many commits (each commit adds one small, separately scanned fragment)... */
  optimizeEveryCommits: number;
  /** ...or this long has passed since the last optimize with at least one row written... */
  optimizeIntervalMs: number;
  /** ...but never sooner than this after the previous optimize (each run adds one index segment). */
  optimizeMinIntervalMs: number;
};

export type LanceDbMaintenanceSettings = LanceDbMaintenanceOptions & LanceDbCadencePolicy & {
  enabled: boolean;
  mode: LanceDbMaintenanceMode;
  /** Max pages per write window (direct mode only). */
  reindexPages: number;
  writeMode: LanceDbWriteMode;
  versionRetentionMs: number;
  maxIndexSegments: number;
  consolidateMaxRows: number;
  /** Queued mode: max documents and records per merge-insert commit. */
  queueBatchDocuments: number;
  queueBatchRecords: number;
  /** Queued mode: how long a document waits for its rows to be committed before failing (retryable). */
  queueWaitTimeoutMs: number;
};

/** Defaults chosen from internal research notes */
export const DEFAULT_LANCEDB_CADENCE: LanceDbCadencePolicy & { maxIndexSegments: number; consolidateMaxRows: number } = {
  // A commit's rows land in one fragment; 2,000 rows (~1,000 pages) bounds the flat-scanned tail.
  optimizeEveryRows: 2_000,
  // Best measured trade-off between tail fragments (slower merge-insert and query) and index
  // segments (one per optimize): 20 commits beat 1, 4, 100 and "never" at 10k and 100k rows.
  optimizeEveryCommits: 20,
  // Staleness bound for trickle traffic (unchanged from the old interval).
  optimizeIntervalMs: 300_000,
  // Caps segment growth at 60 per hour per table under sustained load.
  optimizeMinIntervalMs: 60_000,
  // Query p50 rose from ~3 ms (1 segment) to 7-10 ms at ~30 and 15-20 ms at 60-76 segments.
  maxIndexSegments: 32,
  // A rebuild at 100k rows took 210 s wall / 380 s CPU and held a second table copy for the
  // retention window; larger tables keep their segments until a deliberate reindex.
  consolidateMaxRows: 100_000,
};

/** Inline (legacy) mode's queued-writer row trigger, the default before the cadence policy. */
export const LEGACY_OPTIMIZE_EVERY_ROWS = 20_000;

/**
 * Maintenance and write-path tuning from LANCEDB_URI, e.g.
 * s3://bucket/lancedb?vectorIndexMinRows=1000&versionRetentionMinutes=10&writeMode=queued.
 * Environment variables override the URI: LANCEDB_WRITE_MODE, LANCEDB_MAINTENANCE_MODE,
 * LANCEDB_OPTIMIZE_EVERY_ROWS, LANCEDB_OPTIMIZE_EVERY_COMMITS, LANCEDB_OPTIMIZE_INTERVAL_SECONDS,
 * LANCEDB_OPTIMIZE_MIN_INTERVAL_SECONDS, LANCEDB_MAX_INDEX_SEGMENTS, LANCEDB_CONSOLIDATE_MAX_ROWS.
 */
export function lanceDbMaintenanceSettings(
  params: URLSearchParams,
  env: Record<string, string | undefined> = process.env,
): LanceDbMaintenanceSettings {
  const read = (name: string, envName?: string) => (envName ? env[envName]?.trim() || null : null) ?? params.get(name);
  const positive = (name: string, fallback: number, envName?: string) => {
    const raw = read(name, envName);
    const value = Number(raw);
    return raw !== null && raw !== "" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
  };
  /** Like positive() but 0 is meaningful (disables the knob). */
  const nonNegative = (name: string, fallback: number, envName?: string) => {
    const raw = read(name, envName);
    const value = Number(raw);
    return raw !== null && raw !== "" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
  };
  const mode = (env.LANCEDB_WRITE_MODE ?? params.get("writeMode") ?? "queued").trim().toLowerCase();
  const maintenanceMode = (read("maintenanceMode", "LANCEDB_MAINTENANCE_MODE") ?? "background").trim().toLowerCase();
  const d = DEFAULT_LANCEDB_CADENCE;
  const inline = maintenanceMode === "inline";
  return {
    enabled: !/^(0|false|no|off)$/i.test(params.get("maintenance") ?? ""),
    mode: inline ? "inline" : "background",
    reindexPages: positive("reindexPages", 20),
    vectorIndexMinRows: positive("vectorIndexMinRows", 1_000),
    writeMode: mode === "direct" ? "direct" : "queued",
    versionRetentionMs: positive("versionRetentionMinutes", 10) * 60_000,
    optimizeEveryRows: positive("optimizeEveryRows", inline ? LEGACY_OPTIMIZE_EVERY_ROWS : d.optimizeEveryRows, "LANCEDB_OPTIMIZE_EVERY_ROWS"),
    optimizeEveryCommits: positive("optimizeEveryCommits", d.optimizeEveryCommits, "LANCEDB_OPTIMIZE_EVERY_COMMITS"),
    optimizeIntervalMs: positive("optimizeIntervalSeconds", d.optimizeIntervalMs / 1_000, "LANCEDB_OPTIMIZE_INTERVAL_SECONDS") * 1_000,
    optimizeMinIntervalMs:
      nonNegative("optimizeMinIntervalSeconds", d.optimizeMinIntervalMs / 1_000, "LANCEDB_OPTIMIZE_MIN_INTERVAL_SECONDS") * 1_000,
    maxIndexSegments: inline ? 0 : nonNegative("maxIndexSegments", d.maxIndexSegments, "LANCEDB_MAX_INDEX_SEGMENTS"),
    consolidateMaxRows: nonNegative("consolidateMaxRows", d.consolidateMaxRows, "LANCEDB_CONSOLIDATE_MAX_ROWS"),
    queueBatchDocuments: positive("queueBatchDocuments", 256),
    queueBatchRecords: positive("queueBatchRecords", 20_000),
    queueWaitTimeoutMs: positive("queueWaitTimeoutSeconds", 600) * 1_000,
  };
}

/**
 * The cadence decision, from counters that are cheap to keep (no Lance call): rows and
 * commits written since the last optimize and when it ran. The queued writer evaluates the
 * same predicate in SQL (LanceDbWriteQueue.maybeMaintain); direct mode keeps the counters in
 * memory (DirectMaintenanceCadence).
 */
export function lanceDbMaintenanceDue(
  counters: { rowsSince: number; commitsSince: number; lastOptimizedAt: number | null },
  policy: LanceDbCadencePolicy,
  now = Date.now(),
): boolean {
  if (counters.rowsSince <= 0) return false;
  if (counters.lastOptimizedAt === null) return true;
  const elapsed = now - counters.lastOptimizedAt;
  if (elapsed < policy.optimizeMinIntervalMs) return false;
  return counters.rowsSince >= policy.optimizeEveryRows
    || counters.commitsSince >= policy.optimizeEveryCommits
    || elapsed >= policy.optimizeIntervalMs;
}

export type LanceDbMaintenanceResult = {
  ok: boolean;
  rows: number | null;
  optimizedMs: number | null;
  indexCreated: boolean;
  /** Whether the vector index was rebuilt into one segment (maxIndexSegments exceeded). */
  consolidated?: boolean;
  /** Vector index segments and rows not yet covered by it, after this run. */
  indexSegments?: number | null;
  unindexedRows?: number | null;
  /** Fragments merged away by compaction and old versions / bytes removed by cleanup. */
  fragmentsRemoved?: number;
  versionsRemoved?: number;
  bytesRemoved?: number;
  error?: string;
};

// listIndices() reads index statistics; opt into the lighter centroid-free statistics (the
// upcoming Lance default) so per-window maintenance neither loads centroids nor logs a warning.
process.env.LANCE_INCLUDE_VECTOR_CENTROIDS ??= "false";

/** Pool / coordinator key of one Lance table (shared by every maintenance path). */
export const lanceMaintenanceKey = (uri: string, tableName: string) => `${uri}\u0000${tableName}`;

type MaintenanceTask = () => Promise<void>;
type Slot = { running: Promise<void>; pending: Promise<void> | null };

/**
 * Serializes awaited maintenance per key. While a run is active, further requests coalesce
 * into exactly one follow-up run (dirty flag) instead of queueing one run per request. Used by
 * callers that wait for maintenance anyway (inline mode, the superseded-document purge), so
 * keys are not bounded by the background pool's concurrency, as before.
 */
export function createMaintenanceCoordinator() {
  const slots = new Map<string, Slot>();

  const launch = (key: string, slot: Slot, task: MaintenanceTask): Promise<void> =>
    task().catch(() => undefined).finally(() => {
      if (!slot.pending && slots.get(key) === slot) slots.delete(key);
    });

  return {
    request(key: string, task: MaintenanceTask): Promise<void> {
      const existing = slots.get(key);
      if (!existing) {
        const slot: Slot = { running: Promise.resolve(), pending: null };
        slots.set(key, slot);
        slot.running = launch(key, slot, task);
        return slot.running;
      }
      if (existing.pending) return existing.pending;
      existing.pending = existing.running.then(() => {
        existing.pending = null;
        existing.running = launch(key, existing, task);
        return existing.running;
      });
      return existing.pending;
    },
    activeKeys(): number {
      return slots.size;
    },
  };
}

const coordinator = createMaintenanceCoordinator();

/**
 * Request optimize + vector-index maintenance for one LanceDB table and wait for it. Runs are
 * serialized per table within this process and coalesced while busy. Never rejects: failures
 * (for example commit conflicts with other workers' writes) are logged and swallowed.
 */
export function requestLanceDbMaintenance(
  uri: string,
  tableName: string,
  options: LanceDbMaintenanceOptions,
): Promise<void> {
  return coordinator.request(lanceMaintenanceKey(uri, tableName), async () => {
    await runLanceDbMaintenance(uri, tableName, options);
  });
}

/**
 * Background maintenance: hand the run to the process maintenance pool without waiting. The
 * pool keeps it referenced until it settles, runs one per table, bounds concurrency across
 * tables and drains on graceful shutdown. Returns false once the pool is closing.
 */
export function scheduleLanceDbMaintenance(uri: string, tableName: string, options: LanceDbMaintenanceOptions): boolean {
  return lanceMaintenancePool().schedule(lanceMaintenanceKey(uri, tableName), () => runLanceDbMaintenance(uri, tableName, options));
}

/** Below this many rows a merge-insert scan is cheap and a btree on "id" is not worth building. */
const ID_INDEX_MIN_ROWS = 1_000;

/**
 * LANCEDB_FTS_INDEX (on unless 0/false): maintenance also keeps a native
 * full-text (BM25) index on the chunk `text` column, which native search
 * queries instead of Postgres FTS. optimize() folds new rows into it like the
 * vector index; rows written since are still searched, by a flat scan.
 */
export function lanceDbFtsIndexEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !["0", "false", "off", "no"].includes((env.LANCEDB_FTS_INDEX ?? "").trim().toLowerCase());
}

/** The chunk-text FTS index: English stemming and stop words, no positions (no phrase queries). */
export function chunkTextFtsIndex(): Index {
  return Index.fts({ withPosition: false, language: "English", stem: true, removeStopWords: true, lowercase: true, asciiFolding: true });
}

/** True when the table has an FTS index on `text`. */
export function hasChunkTextFtsIndex(indices: Array<{ indexType?: string; columns: string[] }>): boolean {
  return indices.some((index) => index.columns.includes("text") && /fts|inverted/i.test(index.indexType ?? ""));
}

/** Choose ANN parameters; L2 matches the app's default vectorSearch distance. */
function vectorIndexConfig(rows: number): Index {
  // HNSW_SQ needs no PQ training minimum (IVF_PQ requires >= 256 rows) and keeps 8-bit
  // scalar codes, so recall stays high without a refine step at query time.
  return Index.hnswSq({ distanceType: "l2", numPartitions: Math.max(1, Math.ceil(rows / 1_000_000)) });
}

export async function runLanceDbMaintenance(
  uri: string,
  tableName: string,
  options: LanceDbMaintenanceOptions,
): Promise<LanceDbMaintenanceResult> {
  const started = performance.now();
  let db: Connection | undefined;
  let table: Table | undefined;
  let rows: number | null = null;
  let optimizedMs: number | null = null;
  let indexCreated = false;
  let consolidated = false;
  try {
    db = await connectLanceDb(uri);
    table = await db.openTable(tableName);
    const retentionMs = options.versionRetentionMs;
    const optimizeOptions = () =>
      retentionMs !== undefined ? { cleanupOlderThan: new Date(Date.now() - Math.max(0, retentionMs)) } : undefined;
    // Compacts small write fragments, prunes versions older than the retention window,
    // and folds newly written rows into any existing indices (as one new index segment).
    const optimizeStarted = performance.now();
    const stats = await table.optimize(optimizeOptions());
    optimizedMs = Math.round(performance.now() - optimizeStarted);
    rows = await table.countRows();
    let indices = await table.listIndices();
    let vectorIndex = indices.find((index) => index.columns.includes("vector"));
    if (rows >= Math.max(1, options.vectorIndexMinRows) && !vectorIndex) {
      // replace=false: a concurrent worker that already built the index wins.
      await table.createIndex("vector", { config: vectorIndexConfig(rows), replace: false });
      indexCreated = true;
    } else if (
      vectorIndex
      && options.maxIndexSegments
      && (vectorIndex.numSegments ?? 1) > options.maxIndexSegments
      && (!options.consolidateMaxRows || rows <= options.consolidateMaxRows)
    ) {
      // Collapse the delta segments into one index, then compact: fragments split by segment
      // boundaries become mergeable once a single segment covers them all.
      await table.createIndex("vector", { config: vectorIndexConfig(rows), replace: true });
      const compacted = await table.optimize(optimizeOptions());
      stats.compaction.fragmentsRemoved += compacted.compaction.fragmentsRemoved;
      stats.prune.oldVersionsRemoved += compacted.prune.oldVersionsRemoved;
      stats.prune.bytesRemoved += compacted.prune.bytesRemoved;
      consolidated = true;
    }
    if (rows >= ID_INDEX_MIN_ROWS && !indices.some((index) => index.columns.includes("id"))) {
      // merge-insert joins on "id"; a btree lets it look keys up instead of scanning the table.
      await table.createIndex("id", { config: Index.btree(), replace: false });
    }
    if (lanceDbFtsIndexEnabled() && rows > 0 && !hasChunkTextFtsIndex(indices)) {
      await table.createIndex("text", { config: chunkTextFtsIndex(), replace: false });
    }
    if (indexCreated || consolidated) {
      indices = await table.listIndices();
      vectorIndex = indices.find((index) => index.columns.includes("vector"));
    }
    const indexSegments = vectorIndex ? vectorIndex.numSegments ?? null : null;
    const unindexedRows = vectorIndex ? vectorIndex.numUnindexedRows ?? null : null;
    const fragmentsRemoved = stats?.compaction?.fragmentsRemoved ?? 0;
    const versionsRemoved = stats?.prune?.oldVersionsRemoved ?? 0;
    const bytesRemoved = stats?.prune?.bytesRemoved ?? 0;
    console.log(
      `[lancedb] maintenance table=${tableName} rows=${rows} optimized_ms=${optimizedMs} ` +
        `fragments_removed=${fragmentsRemoved} versions_removed=${versionsRemoved} bytes_removed=${bytesRemoved} ` +
        `index_created=${indexCreated} consolidated=${consolidated} index_segments=${indexSegments ?? "-"} ` +
        `unindexed_rows=${unindexedRows ?? "-"} total_ms=${Math.round(performance.now() - started)}`,
    );
    return {
      ok: true, rows, optimizedMs, indexCreated, consolidated, indexSegments, unindexedRows,
      fragmentsRemoved, versionsRemoved, bytesRemoved,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[lancedb] maintenance failed table=${tableName} rows=${rows ?? "?"} ` +
        `total_ms=${Math.round(performance.now() - started)} error=${message.split("\n")[0]}`,
    );
    return { ok: false, rows, optimizedMs, indexCreated, consolidated, error: message };
  } finally {
    table?.close();
    db?.close();
  }
}
