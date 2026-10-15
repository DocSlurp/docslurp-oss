import { describe, expect, it } from "vitest";

import { createConcurrencyLimiter, createSerialQueue, createThrottledWriter, runBounded } from "./bounded-concurrency.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("runBounded", () => {
  it("keeps index order and never exceeds the concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await runBounded(10, 3, async (index) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep((10 - index) * 2);
      inFlight--;
      return index * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(peak).toBe(3);
  });

  it("starts nothing new after a failure but lets in-flight tasks finish", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    await expect(runBounded(8, 2, async (index) => {
      started.push(index);
      if (index === 0) throw new Error("boom");
      await sleep(10);
      finished.push(index);
    })).rejects.toThrow("boom");
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([1]);
  });
});

describe("createConcurrencyLimiter", () => {
  it("shares a slot pool across callers", async () => {
    const limiter = createConcurrencyLimiter(2);
    let inFlight = 0;
    let peak = 0;
    const task = () => limiter.run(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
    });
    await Promise.all([runBounded(4, 4, task), runBounded(4, 4, task)]);
    expect(peak).toBe(2);
  });
});

describe("createSerialQueue", () => {
  it("runs tasks one at a time in call order, even after a failure", async () => {
    const serial = createSerialQueue();
    const order: string[] = [];
    const a = serial(async () => { await sleep(10); order.push("a"); });
    const b = serial(async () => { order.push("b"); throw new Error("b failed"); });
    const c = serial(async () => { order.push("c"); });
    await a;
    await expect(b).rejects.toThrow("b failed");
    await c;
    expect(order).toEqual(["a", "b", "c"]);
  });
});

describe("createThrottledWriter", () => {
  it("coalesces requests to one write per interval and always writes on flush", async () => {
    let writes = 0;
    const writer = createThrottledWriter(async () => { writes++; await sleep(2); }, 50);
    for (let i = 0; i < 20; i++) writer.request();
    expect(writes).toBe(1);
    await sleep(80);
    expect(writes).toBe(2);
    await writer.flush();
    expect(writes).toBe(3);
  });

  it("rethrows a failed background write from the next request and from flush", async () => {
    const writer = createThrottledWriter(async () => { throw new Error("spend refused"); }, 0);
    writer.request();
    await sleep(1);
    expect(() => writer.request()).toThrow("spend refused");
    await expect(writer.flush()).rejects.toThrow("spend refused");
  });

  it("never overlaps writes, including a scheduled write still pending when flush runs", async () => {
    let inFlight = 0;
    let peak = 0;
    let writes = 0;
    const writer = createThrottledWriter(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      writes++;
      await sleep(20);
      inFlight--;
    }, 5);
    writer.request(); // starts write 1
    writer.request(); // schedules write 2 behind it
    await sleep(10); // timer fired while write 1 is still running
    await writer.flush(); // write 3, chained after write 2
    expect(peak).toBe(1);
    expect(writes).toBe(3);
  });

  it("captures a write that throws synchronously without an unhandled rejection", async () => {
    const writer = createThrottledWriter((() => { throw new Error("sync boom"); }) as () => Promise<void>, 0);
    writer.request();
    await sleep(1);
    expect(() => writer.check()).toThrow("sync boom");
    await writer.settle();
  });

  it("drain makes one final write after a failure without throwing", async () => {
    let writes = 0;
    const writer = createThrottledWriter(async () => { writes++; if (writes === 1) throw new Error("first failed"); }, 1000);
    writer.request();
    writer.request(); // scheduled, dropped by drain
    await writer.drain();
    expect(writes).toBe(2);
  });
});
