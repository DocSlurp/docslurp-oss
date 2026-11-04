import { describe, expect, it, vi } from "vitest";
vi.mock("../usage-attribution.js", () => ({ providerCostLossItems: vi.fn() }));
const { ProviderCostLossMonitor, providerCostLossChecks, resolveProviderCostLossSettings } = await import("./provider-cost-loss.js");
type Item = Parameters<typeof providerCostLossChecks>[1][number];
type Org = Parameters<typeof providerCostLossChecks>[0][number];
const totals = (items: Item[]): Org[] => {
  const byOrg = new Map<string, Org>();
  for (const i of items) {
    const org = byOrg.get(i.orgId) ?? { orgId: i.orgId, lossCents: 0, providerCostCents: 0, creditCents: 0, estimatedCostCents: 0, items: 0, refundedItems: 0 };
    if (i.refunded) org.refundedItems += 1;
    else { org.lossCents += i.lossCents; org.providerCostCents += i.providerCostCents; org.creditCents += i.creditCents; org.estimatedCostCents += i.estimatedCostCents; org.items += 1; }
    byOrg.set(i.orgId, org);
  }
  return [...byOrg.values()];
};

const item = (overrides: Partial<Item> = {}): Item => ({
  kind: "chat-turn", key: "t1", orgId: "o1", creditCents: 1, providerCostCents: 3, estimatedCostCents: 0, lossCents: 2,
  refunded: false, topModel: "vendor/model", lastEventAt: new Date(), ...overrides,
});
const settings = { thresholdCents: 100, intervalMs: 300_000, settleMs: 120_000, windowMs: 3_600_000 };

describe("provider cost loss checks", () => {
  it("fires per org at the threshold, excludes refunded turns and resolves orgs that recover", () => {
    const items = [item({ lossCents: 60 }), item({ key: "t2", lossCents: 50, topModel: "vendor/other" }), item({ key: "t3", lossCents: 500, refunded: true }), item({ orgId: "o2", lossCents: 99 })];
    const checks = providerCostLossChecks(totals(items), items, 100, new Set(["o3"]));
    expect(checks.map((check) => [check.id, check.state])).toEqual([
      ["provider-cost-loss:o1", "firing"], ["provider-cost-loss:o3", "ok"],
    ]);
    expect(checks[0]).toMatchObject({ details: { lossCents: 110, items: 2, refundedItems: 1, topModels: "vendor/model,vendor/other" } });
    // A previously firing org now under the threshold resolves.
    const recovered = [item({ orgId: "o2", lossCents: 5 })];
    expect(providerCostLossChecks(totals(recovered), recovered, 100, new Set(["o2"]))[0]).toMatchObject({ state: "ok" });
  });

  it("reads thresholds from the environment, with 0 disabling", () => {
    expect(resolveProviderCostLossSettings({})).toMatchObject({ thresholdCents: 100, intervalMs: 300_000 });
    expect(resolveProviderCostLossSettings({ ALERT_PROVIDER_LOSS_CENTS: "0", ALERT_PROVIDER_LOSS_INTERVAL_MS: "5" })).toMatchObject({ thresholdCents: 0, intervalMs: 300_000 });
  });
});

describe("ProviderCostLossMonitor", () => {
  function monitor(items: Item[][], billing = true) {
    let now = 10_000_000;
    const state = { billing };
    const query = vi.fn(async () => { const next = items.shift() ?? []; return { items: next, orgs: totals(next) }; });
    const emit = vi.fn();
    const instance = new ProviderCostLossMonitor(settings, { query, now: () => now, emit, billingEnforced: () => state.billing });
    return { instance, query, emit, state, advance: (ms: number) => { now += ms; } };
  }

  it("emits each loss item once, throttles queries and resolves after recovery", async () => {
    const m = monitor([[item({ lossCents: 150 })], [item({ lossCents: 150 }), item({ key: "t2" })], []]);
    expect((await m.instance.evaluate())[0]).toMatchObject({ state: "firing" });
    expect(m.query).toHaveBeenCalledWith({ since: new Date(10_000_000 - 120_000 - 3_600_000), until: new Date(10_000_000 - 120_000) });
    m.advance(60_000);
    expect((await m.instance.evaluate())[0]).toMatchObject({ state: "firing" });
    expect(m.query).toHaveBeenCalledTimes(1);
    m.advance(300_000);
    await m.instance.evaluate();
    expect(m.emit.mock.calls.map(([emitted]) => emitted.key)).toEqual(["t1", "t2"]);
    m.advance(300_000);
    expect(await m.instance.evaluate()).toEqual([expect.objectContaining({ id: "provider-cost-loss:o1", state: "ok" })]);
  });

  it("does nothing while billing is off and reports unknown, not ok, when the query fails", async () => {
    const off = monitor([[item({ lossCents: 500 })]], false);
    expect(await off.instance.evaluate()).toEqual([]);
    expect(off.query).not.toHaveBeenCalled();

    const m = monitor([[item({ lossCents: 500 })]]);
    await m.instance.evaluate();
    m.query.mockRejectedValueOnce(new Error("db down"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    m.advance(300_000);
    expect(await m.instance.evaluate()).toEqual([{ id: "provider-cost-loss:o1", state: "unknown", reason: "loss query failed" }]);
    // Switching billing off resolves the firing alert instead of leaving it active.
    m.state.billing = false;
    expect(await m.instance.evaluate()).toEqual([expect.objectContaining({ id: "provider-cost-loss:o1", state: "ok" })]);
    expect(await m.instance.evaluate()).toEqual([]);
  });
});
