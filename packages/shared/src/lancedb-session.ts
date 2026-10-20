import { totalmem } from "node:os";

/**
 * Environment-driven LanceDB cache, prewarm and read-consistency settings shared by the
 * server and the worker. Pure (no @lancedb import) so it is cheap to test; each process
 * builds its own `Session` from `resolveLanceSessionConfig()`.
 *
 * LanceDB's own Session defaults are 6 GB (index) and 1 GB (metadata) regardless of the
 * machine, so a 2 GB container could be OOM-killed by a warm cache. Unset values therefore
 * default to a fraction of the memory the process may actually use (cgroup limit when set).
 */

const MB = 1024 * 1024;
/** LanceDB's own defaults; also the upper bound of the RAM-relative defaults. */
export const LANCE_DEFAULT_INDEX_CACHE_BYTES = 6 * 1024 * MB;
export const LANCE_DEFAULT_METADATA_CACHE_BYTES = 1024 * MB;

export interface LanceSessionConfig {
  indexCacheBytes: number;
  metadataCacheBytes: number;
  /** "env" when the operator set the size, "auto" when derived from available memory. */
  indexCacheSource: "env" | "auto";
  metadataCacheSource: "env" | "auto";
  /** Seconds between checks for a new table version (0 = check on every query). */
  readConsistencySeconds: number;
  /** Prewarm the vector (and FTS) indexes when a table is opened. */
  prewarmIndex: boolean;
  /** Also prewarm vector/id/documentId column data (RAM cost: the size of those columns). */
  prewarmData: boolean;
  /** Await the prewarm before the first query instead of running it in the background. */
  prewarmBlocking: boolean;
}

type Env = Record<string, string | undefined>;

function parseNumber(env: Env, name: string, min: number, integer = false): number | undefined {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} must be ${integer ? "an integer" : "a number"} >= ${min} (got "${raw}")`);
  }
  return value;
}

function parseBool(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean (got "${raw}")`);
}

/** Memory this process may use: the cgroup limit when one applies, else physical RAM. */
export function availableMemoryBytes(): number {
  const limit = process.constrainedMemory?.() ?? 0;
  const total = totalmem();
  return limit > 0 && limit < total ? limit : total;
}

export function resolveLanceSessionConfig(env: Env = process.env, memoryBytes: number = availableMemoryBytes()): LanceSessionConfig {
  const indexMb = parseNumber(env, "LANCEDB_INDEX_CACHE_MB", 1, true);
  const metadataMb = parseNumber(env, "LANCEDB_METADATA_CACHE_MB", 1, true);
  const readConsistencySeconds = parseNumber(env, "LANCEDB_READ_CONSISTENCY_SECONDS", 0) ?? 10;
  // 25% / 5% of usable memory, capped at LanceDB's defaults and floored so tiny machines still cache.
  const autoIndex = Math.min(LANCE_DEFAULT_INDEX_CACHE_BYTES, Math.max(64 * MB, Math.floor(memoryBytes * 0.25)));
  const autoMetadata = Math.min(LANCE_DEFAULT_METADATA_CACHE_BYTES, Math.max(32 * MB, Math.floor(memoryBytes * 0.05)));
  return {
    indexCacheBytes: indexMb !== undefined ? indexMb * MB : autoIndex,
    metadataCacheBytes: metadataMb !== undefined ? metadataMb * MB : autoMetadata,
    indexCacheSource: indexMb !== undefined ? "env" : "auto",
    metadataCacheSource: metadataMb !== undefined ? "env" : "auto",
    readConsistencySeconds,
    prewarmIndex: parseBool(env, "LANCEDB_PREWARM_INDEX", true),
    prewarmData: parseBool(env, "LANCEDB_PREWARM_DATA", false),
    prewarmBlocking: parseBool(env, "LANCEDB_PREWARM_BLOCKING", false),
  };
}

/** One `[lancedb-session]` log line describing a session's configured and current cache use. */
export function formatLanceSessionLog(
  event: string,
  config: LanceSessionConfig,
  usage?: { sizeBytes: bigint | number; approxNumItems: number },
): string {
  const mb = (bytes: number) => Math.round(bytes / MB);
  let line = `[lancedb-session] ${event} index_cache_mb=${mb(config.indexCacheBytes)}(${config.indexCacheSource}) `
    + `metadata_cache_mb=${mb(config.metadataCacheBytes)}(${config.metadataCacheSource}) `
    + `read_consistency_s=${config.readConsistencySeconds}`;
  if (usage) line += ` cached_mb=${(Number(usage.sizeBytes) / MB).toFixed(1)} cached_items=${usage.approxNumItems}`;
  return line;
}
