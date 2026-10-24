import { afterEach, describe, expect, it, vi } from "vitest";


vi.mock("../services/billing/auto-recharge.js", () => ({ runAutoRecharge: vi.fn(async () => undefined) }));
vi.mock("../services/billing/metering.js", () => ({ syncMeteringEnforcement: vi.fn(async () => undefined) }));
vi.mock("../services/billing/storage-meter.js", () => ({ runStorageMeter: vi.fn(async () => undefined) }));
vi.mock("../services/connector-sync-recovery.js", () => ({ sweepInterruptedConnectorSyncs: vi.fn(async () => undefined) }));
vi.mock("../services/spend-paused-runs.js", () => ({ sweepSpendPausedRuns: vi.fn(async () => undefined) }));
vi.mock("../services/billing/credit-leases.js", () => ({ sweepExpiredCreditLeases: vi.fn(async () => undefined) }));
vi.mock("../services/stale-queued-runs.js", () => ({ sweepStaleQueuedRuns: vi.fn(async () => undefined) }));
vi.mock("../services/tenant-offboarding.js", () => ({ resumeOrganizationDeletions: vi.fn(async () => undefined) }));
vi.mock("../services/webhooks.js", () => ({ requestWebhookOutboxDrain: vi.fn(async () => undefined) }));

const { runMaintenanceSweepsOnce } = await import("../services/maintenance-sweeper.js");
const { startWithRetry } = await import("../lib/start-with-retry.js");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("maintenance sweeps isolate failures", () => {
  it("runs every sweep when one rejects with ECONNRESET and another throws synchronously, on every tick", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const ran: string[] = [];
    const list: Array<[string, () => Promise<unknown>]> = [
      ["rejects", async () => { ran.push("rejects"); throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }); }],
      ["throws-sync", (() => { ran.push("throws-sync"); throw new Error("sync boom"); }) as () => Promise<unknown>],
      ["healthy", async () => { ran.push("healthy"); }],
    ];
    runMaintenanceSweepsOnce(list);
    runMaintenanceSweepsOnce(list); // the next tick still runs everything
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ran.filter((name) => name === "healthy")).toHaveLength(2);
    expect(ran.filter((name) => name === "rejects")).toHaveLength(2);
    expect(ran.filter((name) => name === "throws-sync")).toHaveLength(2);
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("[rejects] sweep failed: read ECONNRESET"));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("[throws-sync] sweep failed: sync boom"));
  });
});

describe("startWithRetry (LISTEN subscriptions that fail at boot)", () => {
  it("retries with backoff until the dependency returns", async () => {
    vi.useFakeTimers();
    const log = vi.fn();
    let calls = 0;
    const handle = startWithRetry("webhook-outbox", async () => {
      calls += 1;
      if (calls < 4) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    }, { random: () => 1, log, baseDelayMs: 1_000, maxDelayMs: 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000); // 1s
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000); // 2s
    expect(calls).toBe(3);
    await vi.advanceTimersByTimeAsync(4_000); // 4s, succeeds
    expect(calls).toBe(4);
    await handle.started;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toBe(4); // no further attempts once started
    expect(log).toHaveBeenCalledTimes(3);
  });

  it("stops retrying when stopped", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const handle = startWithRetry("spend-paused-runs", async () => { calls += 1; throw new Error("down"); }, { log: () => undefined });
    await vi.advanceTimersByTimeAsync(0);
    handle.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toBe(1);
    await handle.started;
  });
});
