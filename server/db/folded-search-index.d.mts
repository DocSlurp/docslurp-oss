// Types for folded-search-index.mjs (plain JS so it runs from the app image without a build step).
export type QueryClient = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
export type FoldedIndexSettings = { lockTimeoutMs: number; attempts: number; retryDelayMs: number; maintenanceWorkMem: string };
export type FoldedIndexState = { state: "missing" | "valid" | "invalid"; bytes: number };
export type FoldedIndexResult =
  | { action: "busy" }
  | { action: "present"; bytes: number }
  | { action: "dry-run"; state: FoldedIndexState["state"] }
  | { action: "built"; bytes: number; ms: number };
export declare const INDEX_NAME: string;
export declare const INDEX_EXPRESSION: string;
export declare function buildSettings(env?: Record<string, string | undefined>): FoldedIndexSettings;
export declare function directDatabaseUrl(url: string, env?: Record<string, string | undefined>): string;
export declare function indexState(client: QueryClient): Promise<FoldedIndexState>;
export declare function ensureFoldedIndex(
  client: QueryClient,
  options?: { settings?: FoldedIndexSettings; log?: (message: string) => void; sleep?: (ms: number) => Promise<void>; dryRun?: boolean },
): Promise<FoldedIndexResult>;
