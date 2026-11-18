import type { Sql } from "postgres";

import { reserveChartExportFreeVmRun } from "./chart-export-free-vm-cap.js";
import { reserveFastPageImageRenders } from "./fast-page-image-budget.js";

/**
 * Fleet budgets: Postgres reservations against caps every worker shares, so no worker can exceed a cap on its own count
 * (pipeline CheckpointStore.budgets). A state without a store reserves nothing, and its callers refuse (fail closed).
 */
export interface FleetBudgets {
  /** Reserves a document's share of the run's Fast page-image render budget (fast-page-image-budget.ts); returns the grant. */
  reserveFastPageImageRenders(args: { runId: string; documentId: string; wanted: number; perRun: number }): Promise<number>;
  /** Reserves one free-tier chart-export VM run against the org's hourly cap (chart-export-free-vm-cap.ts). */
  reserveChartExportFreeVmRun(args: { orgId: string; runId: string; documentId: string; perHour: number }): Promise<boolean>;
}

/** The fleet budgets over one database. */
export function postgresFleetBudgets(sql: Sql<Record<string, unknown>>): FleetBudgets {
  return {
    reserveFastPageImageRenders: (args) => reserveFastPageImageRenders(sql, args),
    reserveChartExportFreeVmRun: (args) => reserveChartExportFreeVmRun(sql, args),
  };
}
