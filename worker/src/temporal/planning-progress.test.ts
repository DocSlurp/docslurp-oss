import { afterEach, expect, it, vi } from "vitest";
import { withPlanningProgress } from "./planning-progress.js";

afterEach(() => vi.useRealTimers());
it("bounds stalled I/O heartbeats and clears its timer", async () => {
  vi.useFakeTimers();
  const heartbeat = vi.fn();
  await withPlanningProgress(new AbortController().signal, heartbeat, async (progress) => {
    await vi.advanceTimersByTimeAsync(120_000);
    expect(heartbeat).toHaveBeenCalledTimes(6);
    progress("persisting", 100);
    expect(heartbeat).toHaveBeenLastCalledWith({phase:"persisting", completed:100});
  });
  expect(vi.getTimerCount()).toBe(0);
});
it("stops on cancellation before another persistence step", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const failure = new Error("cancelled");
  const persist = vi.fn();
  await expect(withPlanningProgress(controller.signal, vi.fn(), async (progress) => {
    controller.abort(failure);
    progress("persisting");
    persist();
  })).rejects.toBe(failure);
  expect(persist).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("preserves the work error when heartbeat also fails", async () => {
  vi.useFakeTimers();
  const failure = new Error("storage failed");
  const heartbeat = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error("heartbeat failed"); });
  await expect(withPlanningProgress(new AbortController().signal, heartbeat, async () => {
    await vi.advanceTimersByTimeAsync(10_000);
    throw failure;
  })).rejects.toBe(failure);
  expect(vi.getTimerCount()).toBe(0);
});
