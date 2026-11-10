// Types for runtime-role-check.mjs (plain JS so it runs from the app image without a build step).
export declare const RUNTIME_ROLES: readonly string[];
export declare const RUNTIME_IDENTITY_SQL: string;
export declare function runtimeIdentityProblems(row: Record<string, unknown>, expected: string, options?: { expectedExists?: boolean }): string[];
export declare function checkRuntimeIdentity(client: { query(query: string, params?: unknown[]): Promise<{ rows: unknown[] }> }, expected: string): Promise<string[]>;
