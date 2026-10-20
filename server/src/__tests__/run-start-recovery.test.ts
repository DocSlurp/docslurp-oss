import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  sql: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  warm: vi.fn(async () => true),
  connected: { value: true },
  listeners: [] as Array<() => void>,
  staleSweep: vi.fn(async () => {}),
  maintenanceEnabled: { value: true },
}));

vi.mock("../db.js", () => ({ sql: Object.assign(mocks.sql, { begin: async (fn: (sql: typeof mocks.sql) => unknown) => fn(mocks.sql) }) }));
vi.mock("../lib/temporal.js", () => ({
  startPipelineWorkflow: vi.fn(),
  signalPipelineCancel: vi.fn(),
  signalPipelinePause: vi.fn(),
  signalPipelineResume: vi.fn(),
  warmTemporalClient: mocks.warm,
  isTemporalClientConnected: () => mocks.connected.value,
  onTemporalClientConnected: (listener: () => void) => {
    mocks.listeners.push(listener);
    return () => {};
  },
}));
vi.mock("../services/stale-queued-runs.js", () => ({ sweepStaleQueuedRuns: mocks.staleSweep }));
vi.mock("../services/maintenance-sweeper.js", () => ({
  isMaintenanceSweepEnabled: () => mocks.maintenanceEnabled.value,
}));

const { startRunStartRecovery, stopRunStartRecovery } = await import("../services/run-start-recovery.js");

/** The ignoreBackoff flag interpolated into each claim query. */
function claimFlags(): boolean[] {
  return mocks.sql.mock.calls
    .filter(([strings]) => (strings as TemplateStringsArray).join("").includes("with due as"))
    .map((call) => call[1] as boolean);
}

describe("run-start recovery wiring", () => {
  afterEach(() => {
    stopRunStartRecovery();
    vi.useRealTimers();
    mocks.sql.mockClear();
    mocks.staleSweep.mockClear();
    mocks.warm.mockClear();
    mocks.listeners.length = 0;
  });

  it("runs a boot pass and the stale sweep, then kicks on every Temporal connect", async () => {
    vi.useFakeTimers();
    startRunStartRecovery();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.warm).toHaveBeenCalledOnce();
    expect(claimFlags()).toEqual([false]);
    expect(mocks.staleSweep).toHaveBeenCalledOnce();

    // Temporal (re)connects: deferred runs are retried without waiting out backoff.
    mocks.listeners.forEach((listener) => listener());
    await vi.advanceTimersByTimeAsync(0);
    expect(claimFlags()).toEqual([false, true]);

    // Interval pass, even with the maintenance sweeper enabled.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claimFlags()).toEqual([false, true, false]);
  });

  it("takes over the stale-queued sweep when the maintenance sweeper is disabled", async () => {
    vi.useFakeTimers();
    mocks.maintenanceEnabled.value = false;
    mocks.connected.value = false;
    try {
      startRunStartRecovery();
      await vi.advanceTimersByTimeAsync(60_000);
      // Boot + one per minute.
      expect(mocks.staleSweep).toHaveBeenCalledTimes(2);
      // Disconnected: each tick retries the background connect.
      expect(mocks.warm.mock.calls.length).toBeGreaterThan(10);
    } finally {
      mocks.maintenanceEnabled.value = true;
      mocks.connected.value = true;
    }
  });
});

describe("run-start recovery claim query", () => {
  it("never claims materialize runs (they are started by the query path, not as pipeline runs)", async () => {
    const { createRunStartRecovery } = await import("../services/run-start-recovery.js");
    mocks.sql.mockClear();
    await createRunStartRecovery({
      sql: mocks.sql as never,
      lifecycle: { start: vi.fn() } as never,
      config: { batchSize: 5, leaseMs: 1000 },
    }).sweepOnce();
    const claim = mocks.sql.mock.calls.map(([s]) => (s as TemplateStringsArray).join("")).find((t) => t.includes("for update skip locked") && t.includes("status = 'queued'"));
    expect(claim).toContain("kind <> 'materialize'");
  });
});
