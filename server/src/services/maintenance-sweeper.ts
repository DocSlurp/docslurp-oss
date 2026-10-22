import { withBackgroundSpan } from "@docslurp/shared/observability";
import { runAutoRecharge } from "./billing/auto-recharge.js";
import { syncMeteringEnforcement } from "./billing/metering.js";
import { runStorageMeter } from "./billing/storage-meter.js";
import { sweepInterruptedConnectorSyncs } from "./connector-sync-recovery.js";
import { sweepSpendPausedRuns } from "./spend-paused-runs.js";
import { sweepExpiredCreditLeases } from "./billing/credit-leases.js";
import { sweepStaleQueuedRuns } from "./stale-queued-runs.js";
import { resumeOrganizationDeletions } from "./tenant-offboarding.js";
import { requestWebhookOutboxDrain } from "./webhooks.js";

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

export function startMaintenanceSweeper(): void {
  if (timer || MAINTENANCE_SWEEP_INTERVAL_MS === 0) return;
  timer = setInterval(() => {
    for (const [name, run] of sweeps) {
      withBackgroundSpan(`maintenance.${name}`, run).catch((error) => {
        console.error(`[${name}] sweep failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
  }, MAINTENANCE_SWEEP_INTERVAL_MS);
  timer.unref?.();
}

export function stopMaintenanceSweeper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
