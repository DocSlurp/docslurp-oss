import type { LanceSessionConfig } from "@docslurp/shared/lancedb-session";

/** Columns the search path reads from raw data files (refine, `documentId` filters). */
export const PREWARM_DATA_COLUMNS = ["vector", "id", "documentId"];

/** The slice of lancedb.Table that prewarming needs; lets tests pass a fake. */
export interface PrewarmableTable {
  listIndices(): Promise<Array<{ name: string; indexType: string; columns: string[] }>>;
  prewarmIndex(name: string): Promise<void>;
  prewarmData(columns?: string[]): Promise<void>;
  schema(): Promise<{ fields: Array<{ name: string }> }>;
}

export interface PrewarmResult {
  indexes: string[];
  dataColumns: string[];
  errors: string[];
  ms: number;
}

/**
 * Loads the vector and full-text indexes (and, when enabled, the hot data columns) into the
 * session cache so the first queries after a table opens do not read them from object storage.
 * Best effort: failures are logged and returned, never thrown, because search works without it.
 */
export async function prewarmTable(
  table: PrewarmableTable,
  name: string,
  config: Pick<LanceSessionConfig, "prewarmIndex" | "prewarmData">,
  log: (line: string) => void = console.log,
): Promise<PrewarmResult> {
  const started = performance.now();
  const result: PrewarmResult = { indexes: [], dataColumns: [], errors: [], ms: 0 };
  if (config.prewarmIndex) {
    try {
      const indices = await table.listIndices();
      // Scalar (btree) indexes serve merge-insert in the worker, not search.
      const searchIndexes = indices.filter((index) => index.columns.includes("vector") || /fts|inverted/i.test(index.indexType));
      for (const index of searchIndexes) {
        try {
          await table.prewarmIndex(index.name);
          result.indexes.push(index.name);
        } catch (error) {
          result.errors.push(`index ${index.name}: ${messageOf(error)}`);
        }
      }
    } catch (error) {
      result.errors.push(`listIndices: ${messageOf(error)}`);
    }
  }
  if (config.prewarmData) {
    try {
      // Legacy tables lack some columns; asking for a missing one would fail the whole call.
      const present = new Set((await table.schema()).fields.map((field) => field.name));
      const columns = PREWARM_DATA_COLUMNS.filter((column) => present.has(column));
      if (columns.length > 0) {
        await table.prewarmData(columns);
        result.dataColumns = columns;
      }
    } catch (error) {
      result.errors.push(`prewarmData: ${messageOf(error)}`);
    }
  }
  result.ms = Math.round(performance.now() - started);
  const status = result.errors.length ? `errors=${JSON.stringify(result.errors)}` : "ok";
  log(`[lancedb-session] prewarm table=${name} indexes=${result.indexes.join(",") || "-"} data=${result.dataColumns.join(",") || "-"} ms=${result.ms} ${status}`);
  return result;
}

function messageOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0] ?? "";
}
