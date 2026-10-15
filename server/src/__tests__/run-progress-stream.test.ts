import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceRunProgressSnapshot } from "@docslurp/shared";
import { streamRunProgressSnapshots } from "../services/run-progress-stream.js";

function harness(status = "processing") {
  let invalidate!: () => void;
  let abort!: () => void;
  const frames: { event: string; data: string }[] = [];
  const close = vi.fn(async () => {});
  const snapshot = vi.fn(async () => ({ run: { status, controlState: null }, progress: { pageRollup: { completed: 3, total: 10 } } } as unknown as WorkspaceRunProgressSnapshot));
  const result = streamRunProgressSnapshots({
    snapshot,
    subscribe: async callback => { invalidate = callback; return { close }; },
    stream: { aborted: false, onAbort: callback => { abort = callback; }, writeSSE: async frame => { frames.push(frame); } },
  });
  return { frames, close, snapshot, result, invalidate: () => invalidate(), abort: () => abort() };
}

describe("typed run progress lifecycle", () => {
  afterEach(() => vi.useRealTimers());
  it("delivers one final snapshot and closes its subscription", async () => {
    const h = harness("completed");
    await h.result;
    expect(h.frames.map(frame => frame.event)).toEqual(["snapshot"]);
    expect(JSON.parse(h.frames[0].data).progress.pageRollup).toEqual({ completed: 3, total: 10 });
    expect(h.close).toHaveBeenCalledOnce();
  });
  it("coalesces bursts, reconciles missed notifications, and cleans up abort timers", async () => {
    vi.useFakeTimers();
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 100; i++) h.invalidate();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.snapshot).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.snapshot).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.snapshot).toHaveBeenCalledTimes(3);
    expect(h.frames.filter(frame => frame.event === "heartbeat")).toHaveLength(2);
    h.abort();
    await h.result;
    expect(h.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ends with an explicit access error when authorization is revoked", async () => {
    vi.useFakeTimers();
    const h = harness();
    await vi.advanceTimersByTimeAsync(0);
    h.snapshot.mockResolvedValue(null as never);
    h.invalidate();
    await vi.advanceTimersByTimeAsync(1_000);
    await h.result;
    expect(h.frames.map(frame => frame.event)).toEqual(["snapshot", "error"]);
    expect(JSON.parse(h.frames[1].data).code).toBe("access_revoked");
    expect(h.close).toHaveBeenCalledOnce();
  });
  it("keeps paused runs observable until resumed or cancelled", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.snapshot.mockResolvedValue({ run: { status: "processing", controlState: "paused" } } as WorkspaceRunProgressSnapshot);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.close).not.toHaveBeenCalled();
    h.snapshot.mockResolvedValue({ run: { status: "processing", controlState: "cancelled" } } as WorkspaceRunProgressSnapshot);
    h.invalidate();
    await vi.advanceTimersByTimeAsync(1_000);
    await h.result;
    expect(h.close).toHaveBeenCalledOnce();
  });
});
