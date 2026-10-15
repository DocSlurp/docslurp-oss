import { describe, expect, it, vi } from "vitest";
import { CapacityController } from "./controller.js";
import { capacityEndpoint, isTailnetAddress } from "./network.js";
import type { CapacityLease, CapacityLeaseStore, CapacityProvider, CapacityResource } from "./types.js";
vi.mock("@docslurp/shared/observability", () => ({ emitTelemetryLog: vi.fn(), recordMediaTelemetry: vi.fn() }));
const lease: CapacityLease = { id: "lease", provider: "test", name: "unique-name", scope: { orgId: "o", workspaceId: "w", runId: "r", documentId: "d" },
  createdAt: 1000, deadline: 5000, resourceId: null, beforeIds: ["existing"], hourlyUsd: 1, reservedUsd: 1, status: "creating", costUsd: null };
function fixture() {
  let inventory: CapacityResource[] = [{ id: "existing", name: "existing", createdAt: 0, state: "running" }];
  const provider: CapacityProvider = { id: "test", quote: vi.fn(async () => ({ hourlyUsd: 1, fixedReserveUsd: 0, observedAt: Date.now() })),
    inventory: vi.fn(async () => inventory), create: vi.fn(async () => { inventory.push({ id: "new", name: lease.name, createdAt: 1000, state: "running" }); return "new"; }),
    destroy: vi.fn(async id => { inventory = inventory.filter(row => row.id !== id); }) };
  const store: CapacityLeaseStore = { reserve: vi.fn(async () => lease), attach: vi.fn(async () => {}), deleting: vi.fn(async () => {}),
    deleted: vi.fn(async () => .01), outstanding: vi.fn(async () => [lease]), heartbeat: vi.fn(async () => {}) };
  return { provider, store, controller: new CapacityController(store, new Map([[provider.id, provider]])) };
}
const options = { scope: lease.scope, ttlMs: 1000, budgetUsd: 1, maxConcurrent: 1, maxRunCostCents: 100 };
describe("capacity ownership and independent cleanup", () => {
  it("requires durable admission before creation and verifies deletion twice", async () => {
    const f = fixture(); const acquired = await f.controller.acquire("test", options);
    await f.controller.release(acquired);
    expect(f.provider.destroy).toHaveBeenCalledWith("new");
    expect(f.store.deleted).toHaveBeenCalledTimes(1);
    expect((await f.provider.inventory()).map(row => row.id)).toEqual(["existing"]);
  });
  it("never creates if watchdog or budget admission fails", async () => {
    const f = fixture(); vi.mocked(f.store.reserve).mockRejectedValue(new Error("watchdog stale"));
    await expect(f.controller.acquire("test", options)).rejects.toThrow("watchdog stale");
    expect(f.provider.create).not.toHaveBeenCalled();
  });
  it("reconciles a lost create response by ownership and does not retry create", async () => {
    const f = fixture(); const create = f.provider.create;
    f.provider.create = vi.fn(async name => { await create(name); throw new Error("response lost"); });
    await expect(f.controller.acquire("test", options)).rejects.toThrow("uncertain");
    await f.controller.sweep(6000);
    expect(f.provider.create).toHaveBeenCalledTimes(1); expect(f.provider.destroy).toHaveBeenCalledWith("new");
  });
  it("retains cleanup incidents and refuses pre-existing IDs", async () => {
    const f = fixture(); const acquired = await f.controller.acquire("test", options);
    vi.mocked(f.provider.destroy).mockResolvedValue(undefined);
    await expect(f.controller.release(acquired)).rejects.toThrow("not yet verified");
    expect(f.store.deleted).not.toHaveBeenCalled();
    await expect(f.controller.release({ ...lease, resourceId: "existing" })).rejects.toThrow("pre-existing");
  });
  it("private connectivity has no public fallback", async () => {
    expect(isTailnetAddress("100.64.0.1")).toBe(true); expect(isTailnetAddress("100.128.0.1")).toBe(false);
    await expect(capacityEndpoint("https://{{name}}.tail.ts.net/", "node", true, async () => ["8.8.8.8"])).rejects.toThrow("tailnet addresses");
    await expect(capacityEndpoint("https://public.example/", "node", true)).rejects.toThrow("Tailscale");
    expect(await capacityEndpoint("https://{{name}}.tail.ts.net/", "node", true, async () => ["100.64.0.1"])).toBe("https://node.tail.ts.net/");
  });
});
