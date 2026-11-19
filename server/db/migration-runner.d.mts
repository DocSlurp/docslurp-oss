export declare const LEDGER_SCHEMA: string;
export declare const LEDGER_TABLE: string;
export declare const LEGACY_MIGRATIONS: ReadonlyArray<readonly [file: string, when: number]>;
export declare function migrationNameProblem(file: string): string | null;
export declare function listMigrationFiles(migrationsFolder: string): string[];
export declare function legacyAppliedFiles(newestDrizzleCreatedAt: number | string | null): string[];
export declare function pendingMigrationFiles(files: string[], applied: Iterable<string>): string[];
export declare function applyMigrationFiles(client: {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}, options: {
  migrationsFolder: string;
  env?: Record<string, string | undefined>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{ applied: string[]; late: string[]; changed: string[] }>;
