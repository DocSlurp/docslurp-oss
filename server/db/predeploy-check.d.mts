// Types for predeploy-check.mjs (plain JS so it runs from the app image without a build step).
import type { QueryClient } from "./folded-search-index.mjs";
export type ReportLevel = "ok" | "warn" | "blocker";
export type ReportSection = { title: string; level: ReportLevel; lines: string[] };
export type MigrationJournal = { entries?: Array<{ tag: string; when: number }> };
export declare function pendingMigrations(journal: MigrationJournal, newestAppliedMs: number): string[];
export declare function section(title: string, level: ReportLevel, lines: string[]): ReportSection;
export declare function render(sections: ReportSection[]): string;
export declare function oneOrgPlanSql(migrationSql: string, options?: { webhooksHaveOrg?: boolean }): { plan: string; promotions: string };
export declare function fundedRemovalsHash(removals: ReadonlyArray<{ user_id: string; org_id: string }>): string;
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
    /** --ack-0127: the hash of the funded-removal list an owner reviewed. */
    ack0127?: string | null;
  },
): Promise<ReportSection[]>;
