import { afterEach, describe, expect, it, vi } from "vitest";

const sqlMock = vi.fn();

vi.mock("../db.js", () => ({
  sql: Object.assign(sqlMock, { json: (value: unknown) => value }),
}));

vi.mock("../lib/temporal.js", () => ({
  startPipelineWorkflow: vi.fn(),
}));

const { sweepStaleQueuedRuns } = await import("../services/stale-queued-runs.js");
const { startMaintenanceSweeper } = await import("../services/maintenance-sweeper.js");

describe("stale queued run sweeper", () => {
  afterEach(() => {
    vi.useRealTimers();
    sqlMock.mockReset();
  });

  it("sweeps on its own interval without waiting for a metrics scrape", async () => {
    vi.useFakeTimers();
    // Auto top-up and the storage meter are no-ops without Stripe / the storage flag.
    vi.stubEnv("STRIPE_SECRET_KEY", "");
    vi.stubEnv("DOCSLURP_BILL_STORAGE", "");
    sqlMock.mockResolvedValue([]);

    startMaintenanceSweeper();
    expect(sqlMock).not.toHaveBeenCalled();

    // One query each for the stale-run sweep, connector-sync recovery, webhook
    // outbox drain, metering-enforcement sync and the interrupted org-deletion
    // resume (no past-due sweep: there are no subscriptions), plus three for the credit-lease expiry
    // sweep (expire + prune leases + prune interactive chat holds), and five (six on the first tick) for the
    // document-export sweep (claim due emails and its column fragment, fail stalled,
    // find expired, prune old expired rows) plus the hourly orphan scan on the first tick, and six for
    // the extract sweep (settle, charge, queue downloads, claim emails, claim expired extracts, re-list deleted ones).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sqlMock).toHaveBeenCalledTimes(20);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(sqlMock).toHaveBeenCalledTimes(39);
    vi.unstubAllEnvs();
  });

  it("is single-flight within a process", async () => {
    let release: (rows: unknown[]) => void = () => {};
    sqlMock.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));

    const first = sweepStaleQueuedRuns();
    const second = sweepStaleQueuedRuns();
    expect(second).toBe(first);
    release([]);
    await first;
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });
});
