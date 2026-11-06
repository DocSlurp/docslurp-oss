// Types for runtime-role-check.mjs (plain JS so it runs from the app image without a build step).
export type RuntimeIdentityRow = {
  role?: string;
  superuser?: boolean;
  elevated?: boolean;
  owned_relations?: number;
  can_create?: boolean;
  expected_exists?: boolean;
  member_of_expected?: boolean;
  /** A PRICING_STATE_WRITER_SQL row (@docslurp/shared/pricing-loader), the rule shared with the startup check. */
  pricing?: Record<string, unknown>;
};
export declare const RUNTIME_ROLES: readonly string[];
export declare const RUNTIME_IDENTITY_SQL: string;
export declare function runtimeIdentityProblems(row: RuntimeIdentityRow, expected: string): string[];
export declare function checkRuntimeIdentity(client: { query(query: string, params?: unknown[]): Promise<{ rows: unknown[] }> }, expected: string): Promise<string[]>;
