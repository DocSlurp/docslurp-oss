// Types for predeploy-check.mjs (plain JS so it runs from the app image without a build step).
import type { QueryClient } from "./folded-search-index.mjs";
export type ReportLevel = "ok" | "warn" | "blocker";
export type ReportSection = { title: string; level: ReportLevel; lines: string[] };
export type MigrationJournal = { entries?: Array<{ tag: string; when: number }> };
export declare function pendingMigrations(journal: MigrationJournal, newestAppliedMs: number): string[];
export declare function section(title: string, level: ReportLevel, lines: string[]): ReportSection;
export declare function render(sections: ReportSection[]): string;
export declare function collectReport(client: QueryClient, options: { journal: MigrationJournal; acceptedPiiPatterns: readonly string[] }): Promise<ReportSection[]>;
