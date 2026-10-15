import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ connect: vi.fn(), start: vi.fn() }));
vi.mock("@temporalio/client", () => ({
  Connection: { connect: mocks.connect },
  Client: class {
    workflow = { start: mocks.start };
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});
afterEach(() => vi.restoreAllMocks());

describe("unavailable Temporal connection fallback", () => {
  it("coalesces concurrent progress probes and backs off after a bounded failed connection", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getPipelineTemporalSnapshot } = await import("../lib/temporal.js");
    let rejectConnect!: (error: Error) => void;
    mocks.connect.mockImplementation(() => new Promise((_resolve, reject) => { rejectConnect = reject; }));
    const first = getPipelineTemporalSnapshot("run-1");
    const second = getPipelineTemporalSnapshot("run-2");
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ connectTimeout: 2_000 }));
    rejectConnect(new Error("Failed to connect before the deadline"));
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(await getPipelineTemporalSnapshot("run-3")).toBeNull();
    expect(mocks.connect).toHaveBeenCalledOnce();
  });

  it("allows explicit starts to reconnect during optional-read cooldown", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getPipelineTemporalSnapshot, startPipelineWorkflow } = await import("../lib/temporal.js");
    mocks.connect.mockRejectedValueOnce(new Error("Failed to connect before the deadline"));
    expect(await getPipelineTemporalSnapshot("run-1")).toBeNull();
    mocks.connect.mockResolvedValueOnce({});
    await startPipelineWorkflow("run-1", {} as never);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.start).toHaveBeenCalledOnce();
  });

  it("notifies connect listeners so deferred runs start as soon as Temporal is reachable", async () => {
    const { onTemporalClientConnected, warmTemporalClient, isTemporalClientConnected } = await import("../lib/temporal.js");
    const listener = vi.fn();
    onTemporalClientConnected(listener);
    mocks.connect.mockResolvedValueOnce({});
    expect(await warmTemporalClient()).toBe(true);
    // Background warm-up gets the longer deadline for cold endpoints.
    expect(mocks.connect).toHaveBeenCalledWith(expect.objectContaining({ connectTimeout: 10_000 }));
    await Promise.resolve();
    expect(listener).toHaveBeenCalledOnce();
    expect(isTemporalClientConnected()).toBe(true);
  });

  it("bounds a request's wait on a slow background connect to the request deadline", async () => {
    vi.useFakeTimers();
    try {
      const { warmTemporalClient, startPipelineWorkflow } = await import("../lib/temporal.js");
      let resolveConnect!: (value: unknown) => void;
      mocks.connect.mockImplementation(() => new Promise((resolve) => { resolveConnect = resolve; }));
      const warm = warmTemporalClient();
      const start = startPipelineWorkflow("run-1", {} as never);
      const rejected = expect(start).rejects.toThrow(/could not connect to Temporal/);
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      expect(mocks.connect).toHaveBeenCalledOnce();
      resolveConnect({});
      expect(await warm).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
