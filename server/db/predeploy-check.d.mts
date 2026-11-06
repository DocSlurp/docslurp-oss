// Types for predeploy-check.mjs (plain JS so it runs from the app image without a build step).
import type { QueryClient } from "./folded-search-index.mjs";
export type ReportLevel = "ok" | "warn" | "blocker";
export type ReportSection = { title: string; level: ReportLevel; lines: string[] };
export type MigrationJournal = { entries?: Array<{ tag: string; when: number }> };
/** Vector backends this build writes (shared SUPPORTED_VECTOR_BACKENDS; pinned by rollout-ops-scripts.db.test.ts). */
export declare const SUPPORTED_VECTOR_BACKENDS: readonly string[];
export declare function pendingMigrations(journal: MigrationJournal, newestAppliedMs: number): string[];
export declare function section(title: string, level: ReportLevel, lines: string[]): ReportSection;
export declare function render(sections: ReportSection[]): string;
/** 0127's plan, promotion and acknowledgement queries, read from the migration. `ack` selects funded_removals, promotions, member_promotions and hash; `ownerless` the organizations 0127 refuses to leave ownerless. */
export declare function oneOrgPlanSql(migrationSql: string, options?: { webhooksHaveOrg?: boolean }): { plan: string; promotions: string; ownerless: string; ack: string };
export declare function namer(redact: boolean): { user: (row: { user_id: string; email: string }) => string; org: (id: string, name: string) => string };
export declare function redactOutput(argv: readonly string[], isTTY: boolean | undefined): boolean;
export declare function knownExtractorIds(builtInIds: readonly string[], env?: Record<string, string | undefined>): string[];
export declare function collectReport(
  client: QueryClient,
  options: {
    journal: MigrationJournal;
    acceptedPiiPatterns: readonly string[];
    /** Defaults to the built-in ids plus DOCSLURP_EXTRACTOR_ID_ALIASES keys. */
    extractorIds?: readonly string[];
    /** Defaults to migrations/0127_one_org_per_user.sql. */
    oneOrgMigrationSql?: string;
    /** --ack-0127: the hash of the funded-removal and member-promotion list an owner reviewed. */
    ack0127?: string | null;
    /** Name people and organizations by id only (no emails, no organization names). */
    redact?: boolean;
  },
): Promise<ReportSection[]>;
