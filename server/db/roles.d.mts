// Types for roles.mjs (plain JS so migrate.mjs can load it without a build step).
export type DbRoles = { owner: string; app: string; worker: string; backup: string };
export type WorkerTableSpec = {
  /** Installed only with optional spatial migrations. */
  optional?: boolean;
  privileges: readonly string[];
  columns?: Readonly<Record<string, readonly string[]>>;
  evidence: string;
};
export declare const DEFAULT_DB_ROLES: Readonly<DbRoles>;
export declare const WORKER_TABLES: Readonly<Record<string, WorkerTableSpec>>;
export declare const WORKER_DENIED_TABLES: Readonly<Record<string, string>>;
export declare function quoteIdent(name: string): string;
export declare function roleGrantStatements(options: {
  owner: string;
  roles?: DbRoles;
  present: readonly string[];
  relations: readonly string[];
  sequences?: Readonly<Record<string, string>>;
  migrationsTable?: boolean;
}): string[];
type QueryClient = { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> };
export declare function reconcileRoleGrants(client: QueryClient, options?: { roles?: DbRoles; log?: (line: string) => void }): Promise<string[]>;
export declare function assertMigrationOwner(client: QueryClient): Promise<string>;
