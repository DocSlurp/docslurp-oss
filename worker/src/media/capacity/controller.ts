import { emitTelemetryLog } from "../telemetry.js";
import { recordMediaTelemetry } from "@docslurp/shared/observability";
import type { CapacityLease, CapacityLeaseStore, CapacityProvider } from "./types.js";
export class CapacityController {
  constructor(private readonly store: CapacityLeaseStore, private readonly providers: Map<string, CapacityProvider>) {}
  async acquire(providerId: string, options: Omit<Parameters<CapacityLeaseStore["reserve"]>[0], "provider" | "beforeIds" | "quote">): Promise<CapacityLease> {
    const provider = this.provider(providerId);
    const before = await provider.inventory(); const quote = await provider.quote();
    const lease = await this.store.reserve({ ...options, provider: providerId, beforeIds: before.map(row => row.id), quote });
    this.log(lease, "creating");
    try {
      const id = await provider.create(lease.name);
      await this.store.attach(lease.id, id);
      return { ...lease, resourceId: id, status: "active" };
    } catch {
      // Keep the admission indefinitely if the create outcome cannot be proven.
      this.log(lease, "create_uncertain", true);
      throw new Error(`Capacity creation uncertain; lease ${lease.id} remains covered by the watchdog`);
    }
  }
  async release(lease: CapacityLease): Promise<number> {
    const provider = this.provider(lease.provider);
    const inventory = await provider.inventory();
    const matches = lease.resourceId ? inventory.filter(row => row.id === lease.resourceId)
      : inventory.filter(row => row.name === lease.name && row.createdAt >= lease.createdAt - 1000 && !lease.beforeIds.includes(row.id));
    if (!lease.resourceId && matches.length !== 1) {
      this.log(lease, "ownership_uncertain", true); throw new Error("Ambiguous capacity ownership; admission remains closed");
    }
    const id = lease.resourceId ?? matches[0].id;
    if (lease.beforeIds.includes(id)) throw new Error("Refusing to destroy pre-existing capacity");
    if (!lease.resourceId) await this.store.attach(lease.id, id);
    await this.store.deleting(lease.id);
    if (matches.some(row => row.state !== "deleted")) await provider.destroy(id);
    for (let check = 0; check < 2; check++) {
      if ((await provider.inventory()).some(row => row.id === id && row.state !== "deleted")) {
        this.log(lease, "cleanup_pending", true); throw new Error("Capacity deletion not yet verified");
      }
    }
    const costUsd = await this.store.deleted({ ...lease, resourceId: id }, Date.now());
    emitTelemetryLog({ severityText: "info", body: "media.capacity.cost_recorded",
      attributes: { ...lease.scope, leaseId: lease.id, provider: lease.provider, costUsd, costSource: "estimate" } });
    this.log(lease, "deleted");
    return costUsd;
  }
  async sweep(now = Date.now()): Promise<void> {
    // Heartbeat is valid only after the independent service reached the database.
    await this.store.heartbeat();
    for (const lease of await this.store.outstanding()) {
      if (lease.deadline > now && lease.status !== "deleting") continue;
      try { await this.release(lease); } catch { this.log(lease, "cleanup_incident", true); }
    }
  }
  private provider(id: string): CapacityProvider { const provider = this.providers.get(id); if (!provider) throw new Error("Capacity provider not configured"); return provider; }
  private log(lease: CapacityLease, outcome: string, failed = false) {
    emitTelemetryLog({ severityText: failed ? "error" : "info", body: `media.capacity.${outcome}`,
      attributes: { ...lease.scope, leaseId: lease.id, provider: lease.provider, resourceId: lease.resourceId ?? "pending", deadline: new Date(lease.deadline).toISOString() } });
    recordMediaTelemetry({ provider: lease.provider, model: "capacity", operation: "capacity", outcome, durationSeconds: 0 });
  }
}
