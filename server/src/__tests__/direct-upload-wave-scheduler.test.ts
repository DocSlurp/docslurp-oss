import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDirectUploadWaveCheckHandler, requestDirectUploadWaveCheck, settleDirectUploadWaveChecks } from "../services/direct-upload-wave-scheduler.js";

// The in-process wave timers: best effort beside the durable schedule (next_reconcile_at), one per session.
const handler = vi.fn(async (_sessionId: string) => {});
beforeEach(() => { vi.useFakeTimers(); handler.mockReset().mockResolvedValue(undefined); });
afterEach(() => { registerDirectUploadWaveCheckHandler(null); vi.useRealTimers(); });

describe("direct upload wave timers", () => {
  it("does nothing in a process without the reconciler", async () => {
    requestDirectUploadWaveCheck("s1", 0);
    await vi.advanceTimersByTimeAsync(10);
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps one timer per session, the earliest requested", async () => {
    registerDirectUploadWaveCheckHandler(handler);
    requestDirectUploadWaveCheck("s1", 10_000);
    requestDirectUploadWaveCheck("s1", 20_000);
    requestDirectUploadWaveCheck("s1", 100);
    await vi.advanceTimersByTimeAsync(150);
    expect(handler).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("runs once more right after a check that was running when asked again", async () => {
    registerDirectUploadWaveCheckHandler(handler);
    let finish!: () => void;
    handler.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    requestDirectUploadWaveCheck("s1", 0);
    await vi.advanceTimersByTimeAsync(1);
    requestDirectUploadWaveCheck("s1", 0);
    requestDirectUploadWaveCheck("s1", 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(1);
    await settleDirectUploadWaveChecks();
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("survives a failing check", async () => {
    registerDirectUploadWaveCheckHandler(handler);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    handler.mockRejectedValueOnce(new Error("database down"));
    requestDirectUploadWaveCheck("s1", 0);
    await vi.advanceTimersByTimeAsync(1);
    await settleDirectUploadWaveChecks();
    requestDirectUploadWaveCheck("s1", 0);
    await vi.advanceTimersByTimeAsync(1);
    expect(handler).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
