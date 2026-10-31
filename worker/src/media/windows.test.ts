import { describe, expect, it, vi } from "vitest";
import { MEDIA_CONCURRENCY_EXHAUSTED, mediaWindowConcurrency, readMediaWindowConcurrency, runOrderedWindows } from "./windows.js";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("runOrderedWindows", () => {
  it("returns results in window order when calls finish out of order", async () => {
    const items = [40, 5, 25, 1, 15];
    const results = await runOrderedWindows({
      items, concurrency: 4,
      prepare: async (ms) => ms,
      process: async (ms, _item, index) => { await delay(ms); return `w${index}`; },
    });
    expect(results).toEqual(["w0", "w1", "w2", "w3", "w4"]);
  });

  it("keeps preparation serial and bounds calls in flight", async () => {
    let preparing = 0; let maxPreparing = 0; let flying = 0; let maxFlying = 0;
    await runOrderedWindows({
      items: Array.from({ length: 12 }, (_, i) => i), concurrency: 3,
      prepare: async (i) => { preparing++; maxPreparing = Math.max(maxPreparing, preparing); await delay(1); preparing--; return i; },
      process: async (i) => { flying++; maxFlying = Math.max(maxFlying, flying); await delay(5 + (i % 3)); flying--; return i; },
    });
    expect(maxPreparing).toBe(1);
    expect(maxFlying).toBe(3);
  });

  it("matches sequential processing for concurrency 1", async () => {
    const order: number[] = [];
    await runOrderedWindows({ items: [1, 2, 3], concurrency: 1, prepare: async (i) => i, process: async (i) => { order.push(i); return i; } });
    expect(order).toEqual([1, 2, 3]);
  });

  it("stops scheduling on the first failure, drains in-flight calls, then throws", async () => {
    const started: number[] = []; const settled: number[] = [];
    await expect(runOrderedWindows({
      items: [0, 1, 2, 3, 4, 5], concurrency: 2,
      prepare: async (i) => i,
      process: async (i) => {
        started.push(i);
        if (i === 1) throw new Error("provider failed");
        await delay(20); settled.push(i); return i;
      },
    })).rejects.toThrow("provider failed");
    expect(started).toEqual([0, 1]);
    expect(settled).toEqual([0]);
  });

  it("throws preparation failures without calling the provider for that window", async () => {
    const process = vi.fn(async (i: number) => i);
    await expect(runOrderedWindows({
      items: [0, 1], concurrency: 2,
      prepare: async (i) => { if (i === 1) throw new Error("Audio chunk exceeds limit"); return i; },
      process,
    })).rejects.toThrow("Audio chunk exceeds limit");
    expect(process.mock.calls.map((c) => c[0])).toEqual([0]);
  });

  it("stops scheduling after abort and rethrows the abort reason", async () => {
    const controller = new AbortController();
    const process = vi.fn(async (i: number) => { if (i === 0) controller.abort(new Error("cancelled")); await delay(5); return i; });
    await expect(runOrderedWindows({ items: [0, 1, 2, 3], concurrency: 1, signal: controller.signal, prepare: async (i) => i, process }))
      .rejects.toThrow("cancelled");
    expect(process).toHaveBeenCalledTimes(1);
  });

  it("retries a journal concurrency refusal only while another call is in flight", async () => {
    let refused = false;
    const results = await runOrderedWindows({
      items: [0, 1, 2], concurrency: 3,
      prepare: async (i) => i,
      process: async (i) => {
        if (i === 1 && !refused) { refused = true; throw new Error(`${MEDIA_CONCURRENCY_EXHAUSTED}; uncertain requests need reconciliation`); }
        await delay(5); return i;
      },
    });
    expect(results).toEqual([0, 1, 2]);
  });

  it("throws the journal refusal when nothing else is in flight (the budget refusal path)", async () => {
    await expect(runOrderedWindows({
      items: [0, 1], concurrency: 1, prepare: async (i) => i,
      process: async () => { throw new Error(`${MEDIA_CONCURRENCY_EXHAUSTED}; uncertain requests need reconciliation`); },
    })).rejects.toThrow(MEDIA_CONCURRENCY_EXHAUSTED);
    await expect(runOrderedWindows({
      items: [0, 1], concurrency: 2, prepare: async (i) => i,
      process: async () => { throw new Error("Media run cost cap exhausted"); },
    })).rejects.toThrow("cost cap");
  });

  it("reports per-window timings", async () => {
    const timings: number[] = [];
    await runOrderedWindows({ items: [0, 1], concurrency: 2, prepare: async (i) => i, process: async (i) => i, onTiming: (_i, index) => timings.push(index) });
    expect(timings.sort()).toEqual([0, 1]);
  });
});

describe("mediaWindowConcurrency", () => {
  it("is capped by the journal limit and window count, and sequential for leased capacity", () => {
    expect(mediaWindowConcurrency({ flag: 8, journalMaxConcurrent: 4, windows: 10, leased: false })).toBe(4);
    expect(mediaWindowConcurrency({ flag: 8, journalMaxConcurrent: 10, windows: 3, leased: false })).toBe(3);
    expect(mediaWindowConcurrency({ flag: 8, journalMaxConcurrent: 10, windows: 3, leased: true })).toBe(1);
    expect(mediaWindowConcurrency({ flag: Number.NaN, journalMaxConcurrent: 10, windows: 3, leased: false })).toBe(1);
  });

  it("defaults to sequential and bounds the flag", () => {
    expect(readMediaWindowConcurrency({})).toBe(1);
    expect(readMediaWindowConcurrency({ MEDIA_WINDOW_CONCURRENCY: "0" })).toBe(1);
    expect(readMediaWindowConcurrency({ MEDIA_WINDOW_CONCURRENCY: "abc" })).toBe(1);
    expect(readMediaWindowConcurrency({ MEDIA_WINDOW_CONCURRENCY: "64" })).toBe(16);
  });
});
