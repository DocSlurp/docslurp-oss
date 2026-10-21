/**
 * Columns that let search serve a LanceDB chunk row without reading Postgres
 * `document_chunks` (SEARCH_LANCEDB_NATIVE). Shared by the worker, which
 * writes them with every vector row, and the server, which reads them.
 *
 * - `runId`: the chunk's run (document-level filters stay in the eligible set).
 * - `pageNumber`: the chunk's page; 0 or null means none. Used by `pageRange` filters.
 * - `hydration`: JSON of {@link LanceChunkHydration}, everything a citation needs
 *   that is not already a column (`id`, `documentId`, `chunkIndex`, `text`).
 *
 * The columns are nullable. Older tables get them with `addColumns` (null
 * values) and are filled by `worker/scripts/lancedb-native-backfill.ts`; rows
 * whose `hydration` is still null are hydrated from Postgres. Pure: no
 * @lancedb import.
 */
export const LANCE_HYDRATION_COLUMNS = ["runId", "pageNumber", "hydration"] as const;

/** `addColumns` specs that add the hydration columns to an existing table as nullable. */
export const LANCE_HYDRATION_COLUMN_SPECS: ReadonlyArray<{ name: (typeof LANCE_HYDRATION_COLUMNS)[number]; valueSql: string }> = [
  { name: "runId", valueSql: "CAST(NULL AS STRING)" },
  { name: "pageNumber", valueSql: "CAST(NULL AS DOUBLE)" },
  { name: "hydration", valueSql: "CAST(NULL AS STRING)" },
];

/** Bumped when the hydration payload changes shape; readers fall back to Postgres for other versions. */
export const LANCE_HYDRATION_VERSION = 1;

export interface LanceChunkHydration {
  v: number;
  runId: string;
  headingPath: string[];
  pageNumber: number | null;
  tokenEstimate: number;
  /** The `document_chunks.metadata` value written by the embed stage. */
  metadata: Record<string, unknown>;
}

export function encodeLanceChunkHydration(chunk: {
  runId: string;
  headingPath?: string[] | null;
  pageNumber?: number | null;
  tokenEstimate?: number | null;
  metadata?: Record<string, unknown> | null;
}): string {
  const hydration: LanceChunkHydration = {
    v: LANCE_HYDRATION_VERSION,
    runId: chunk.runId,
    headingPath: chunk.headingPath ?? [],
    pageNumber: typeof chunk.pageNumber === "number" && Number.isFinite(chunk.pageNumber) ? chunk.pageNumber : null,
    tokenEstimate: typeof chunk.tokenEstimate === "number" && Number.isFinite(chunk.tokenEstimate) ? chunk.tokenEstimate : 0,
    metadata: chunk.metadata ?? {},
  };
  return JSON.stringify(hydration);
}

/** Null when the value is missing, unparsable or from another payload version. */
export function decodeLanceChunkHydration(value: unknown): LanceChunkHydration | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<LanceChunkHydration>;
    if (parsed?.v !== LANCE_HYDRATION_VERSION || typeof parsed.runId !== "string") return null;
    return {
      v: parsed.v,
      runId: parsed.runId,
      headingPath: Array.isArray(parsed.headingPath) ? parsed.headingPath.filter((item): item is string => typeof item === "string") : [],
      pageNumber: typeof parsed.pageNumber === "number" ? parsed.pageNumber : null,
      tokenEstimate: typeof parsed.tokenEstimate === "number" ? parsed.tokenEstimate : 0,
      metadata: parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) ? parsed.metadata : {},
    };
  } catch {
    return null;
  }
}

/** Lance stores pages as doubles; 0 means "no page" so new tables infer a non-null numeric type. */
export function lancePageNumberValue(pageNumber: number | null | undefined): number {
  return typeof pageNumber === "number" && Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : 0;
}
