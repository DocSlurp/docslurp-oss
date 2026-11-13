import { withBackgroundSpan } from "@docslurp/shared/observability";
import { runAutoRecharge } from "./billing/auto-recharge.js";
import { syncMeteringEnforcement } from "./billing/metering.js";
import { runStorageMeter } from "./billing/storage-meter.js";
import { sweepInterruptedConnectorSyncs } from "./connector-sync-recovery.js";
import { sweepDocumentExports } from "./document-exports.js";
import { sweepFeedbackReports } from "./feedback-reports.js";
import { sweepExtracts } from "./extracts.js";
import { sweepExpiredSearchSessions } from "./search-history-expiry.js";
import { sweepSpendPausedRuns } from "./spend-paused-runs.js";
import { sweepExpiredCreditLeases } from "./billing/credit-leases.js";
import { sweepStaleQueuedRuns } from "./stale-queued-runs.js";
import { sweepProviderObservations } from "./provider-observations.js";
import { resumeOrganizationDeletions } from "./tenant-offboarding.js";
import { requestWebhookOutboxDrain } from "./webhooks.js";
import { sweepProjectAutoTitles } from "./project-naming.js";

/**
 * Periodic in-process recovery for work that can otherwise get stuck: queued
 * runs whose workflow never started, and connector syncs interrupted by a
 * restart; plus billing upkeep (auto top-up, storage meter).
 * Each billing sweep is idempotent across instances. Set
 * MAINTENANCE_SWEEP_INTERVAL_MS=0 to disable.
 */
const MAINTENANCE_SWEEP_INTERVAL_MS = Math.max(
  0,
  Number(
    process.env.MAINTENANCE_SWEEP_INTERVAL_MS ??
      process.env.STALE_QUEUED_RUN_SWEEP_INTERVAL_MS ??
      60_000,
  ),
);

const sweeps: Array<[name: string, run: () => Promise<unknown>]> = [
  ["stale-queued-run-sweep", sweepStaleQueuedRuns],
  ["connector-sync-recovery", sweepInterruptedConnectorSyncs],
  // Fallback for missed NOTIFYs (listener reconnects, API restarts).
  ["webhook-outbox", requestWebhookOutboxDrain],
  // Billing: off-session auto top-ups below threshold (no-op without Stripe), the
  // daily storage meter (enforced with Stripe, or DOCSLURP_BILL_STORAGE=true),
  // Metering enforcement is republished for workers.
  ["metering-enforcement", syncMeteringEnforcement],
  ["auto-recharge", runAutoRecharge],
  ["storage-meter", runStorageMeter],
  // Runs the worker paused for credits or budget resume once the org may spend.
  ["spend-paused-runs", () => sweepSpendPausedRuns()],
  // Credit leases past their TTL (crashed workers) back to the pool, with a wake-up.
  ["credit-lease-expiry", () => sweepExpiredCreditLeases()],
  // Finish organization deletions interrupted after their tombstone was written.
  ["tenant-offboarding", () => resumeOrganizationDeletions()],
  // Zip exports: email finished large ones, delete objects past their 7-day link.
  ["document-exports", () => sweepDocumentExports()],
  // Feedback reports past FEEDBACK_RETENTION_DAYS or over the per-org cap (hourly).
  ["feedback-retention", () => sweepFeedbackReports()],
  // Extract mode: settle finished extracts (charge, download, email) and delete expired ones.
  ["extracts", () => sweepExtracts()],
  // Route tiers: OpenRouter endpoint prices and uptime every 15 min (DOCSLURP_PROVIDER_OBSERVATIONS=1).
  ["provider-observations", () => sweepProviderObservations()],
  // Expired API-key search history (lean-logging.ts); result rows and diagnostics cascade.
  ["search-history-expiry", () => sweepExpiredSearchSessions()],
  // Automatic project titles from ingested content; project reads never rename (project-naming.ts).
  ["project-auto-titles", () => sweepProjectAutoTitles()],
];

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * False when MAINTENANCE_SWEEP_INTERVAL_MS=0. Run-start recovery
 * (run-start-recovery.ts) runs regardless and takes over the stale-queued
 * sweep in that case.
 */
export function isMaintenanceSweepEnabled(): boolean {
  return MAINTENANCE_SWEEP_INTERVAL_MS > 0;
}

/**
 * One pass over every sweep. Each sweep is isolated: a rejection (ECONNRESET) or a
 * synchronous throw in one neither skips the others nor stops the next tick.
 */
export function runMaintenanceSweepsOnce(list: ReadonlyArray<[name: string, run: () => Promise<unknown>]> = sweeps): void {
  for (const [name, run] of list) {
    Promise.resolve()
      .then(() => withBackgroundSpan(`maintenance.${name}`, run))
      .catch((error) => {
        console.error(`[${name}] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      });
  }
}

export function startMaintenanceSweeper(): void {
  if (timer || MAINTENANCE_SWEEP_INTERVAL_MS === 0) return;
  timer = setInterval(runMaintenanceSweepsOnce, MAINTENANCE_SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopMaintenanceSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
