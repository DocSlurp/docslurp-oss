import { emitTelemetryLog } from "../telemetry.js";
import "../../env.js";
import { setTimeout as delay } from "node:timers/promises";
import { initializeObservability, shutdownObservability } from "@docslurp/shared/observability";
import { Store } from "../../db/store.js";
import { capacityProviders, capacitySettings } from "./runtime.js";
import { CapacityController } from "./controller.js";

/** Run as an independently supervised service, never inside a rented host or ingestion activity. */
async function main() {
  const settings = capacitySettings();
  if (!settings || !process.env.DATABASE_URL) throw new Error("Watchdog configuration missing");
  initializeObservability({ serviceName: "docslurp-media-watchdog" });
  const providers = capacityProviders(settings);
  const store = new Store(process.env.DATABASE_URL, 60000, { poolMax: 2 });
  const leases = store.capacityLeaseStore([...providers.keys()]);
  const controller = new CapacityController(leases, providers);
  const abort = new AbortController();
  process.once("SIGTERM", () => abort.abort()); process.once("SIGINT", () => abort.abort());
  try {
    while (!abort.signal.aborted) {
      try {
        // Prove provider control-plane access before refreshing readiness.
        for (const provider of providers.values()) await provider.inventory();
        await controller.sweep();
        const outstanding = await leases.outstanding();
        emitTelemetryLog({ severityText: outstanding.some(row => row.deadline <= Date.now()) ? "error" : "info",
          body: "media.capacity.watchdog", attributes: { outstanding: outstanding.length,
            overdue: outstanding.filter(row => row.deadline <= Date.now()).length } });
      } catch { emitTelemetryLog({ severityText: "error", body: "media.capacity.watchdog_failed" }); }
      await delay(10000, undefined, { signal: abort.signal }).catch(() => {});
    }
  } finally { await store.close(); await shutdownObservability(); }
}
main().catch(() => { console.error("[media-watchdog] failed; inspect configuration and control-plane access"); process.exitCode = 1; });
