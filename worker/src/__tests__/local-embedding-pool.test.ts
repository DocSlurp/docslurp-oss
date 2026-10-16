import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LocalEmbeddingPool,
  LocalEmbeddingThreadCrashError,
  localEmbeddingIntraOpThreads,
  localEmbeddingPoolSize,
} from "../stages/local-embedding-thread.js";

/**
 * The embedding pool runs model inference on at most `size` worker threads.
 * The fixture stands in for transformers.js and blocks its thread
 * synchronously per batch, as onnxruntime-node does.
 */
const fixtureUrl = new URL("../test/fixtures/busy-transformers.mjs", import.meta.url).href;
const request = (texts: string[], model: string) => ({
  model, dtypes: ["q8", "fp32"], cacheDir: "/nonexistent", texts, normalize: true,
});
const rows = (data: Float32Array, width = 4) =>
  Array.from({ length: data.length / width }, (_, row) => Array.from(data.slice(row * width, (row + 1) * width)));

/** Largest gap between 10 ms timer ticks while `work` runs: event-loop lag. */
async function maxTimerLag(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last - 10);
    last = now;
  }, 10);
  try {
    await work();
    worst = Math.max(worst, performance.now() - last - 10);
  } finally {
    clearInterval(timer);
  }
  return worst;
}

let pool: LocalEmbeddingPool | null = null;
const makePool = (size: number, intraOpThreads = 1, moduleUrl = fixtureUrl) =>
  (pool = new LocalEmbeddingPool({ size, intraOpThreads, moduleUrl: () => moduleUrl }));
afterEach(async () => {
  vi.restoreAllMocks();
  await pool?.close();
  pool = null;
});

describe("local embedding pool sizing", () => {
  it("defaults to min(2, cpus / 4), at least one thread", () => {
    expect(localEmbeddingPoolSize({}, 1)).toBe(1);
    expect(localEmbeddingPoolSize({}, 4)).toBe(1);
    expect(localEmbeddingPoolSize({}, 8)).toBe(2);
    expect(localEmbeddingPoolSize({}, 64)).toBe(2);
  });

  it("honours DOCSLURP_LOCAL_EMBED_THREADS and ignores invalid values", () => {
    expect(localEmbeddingPoolSize({ DOCSLURP_LOCAL_EMBED_THREADS: "3" }, 4)).toBe(3);
    expect(localEmbeddingPoolSize({ DOCSLURP_LOCAL_EMBED_THREADS: "0" }, 8)).toBe(2);
    expect(localEmbeddingPoolSize({ DOCSLURP_LOCAL_EMBED_THREADS: "many" }, 8)).toBe(2);
    expect(localEmbeddingPoolSize({ DOCSLURP_LOCAL_EMBED_THREADS: "999" }, 8)).toBe(16);
  });

  it("splits the cpus across pool threads for ONNX intra-op threads unless overridden", () => {
    expect(localEmbeddingIntraOpThreads(2, {}, 8)).toBe(4);
    expect(localEmbeddingIntraOpThreads(4, {}, 2)).toBe(1);
    expect(localEmbeddingIntraOpThreads(2, { DOCSLURP_LOCAL_EMBED_INTRA_OP_THREADS: "3" }, 8)).toBe(3);
  });

  it("passes the intra-op thread cap to the model session", async () => {
    makePool(1, 5);
    const result = await pool!.embed(request(["abc"], "opts:1"));
    expect(rows(result.data)).toEqual([[3, 5, 3, 3]]);
  }, 30_000);
});

describe("local embedding pool", () => {
  it("returns each caller its own vectors, identical to the in-process pipeline", async () => {
    const { pipeline } = (await import(fixtureUrl)) as {
      pipeline: (task: string, model: string) => Promise<(texts: string[]) => Promise<{ data: Float32Array; dims: number[] }>>;
    };
    const inProcess = await pipeline("feature-extraction", "busy:1");
    makePool(2);
    const batches = Array.from({ length: 8 }, (_, n) => Array.from({ length: n + 1 }, (_, i) => "x".repeat(n * 3 + i + 1)));
    const results = await Promise.all(batches.map((texts) => pool!.embed(request(texts, "busy:5"))));
    for (const [n, texts] of batches.entries()) {
      const expected = await inProcess(texts);
      expect(results[n]!.dims).toEqual(expected.dims);
      expect(Array.from(results[n]!.data)).toEqual(Array.from(expected.data));
    }
  }, 30_000);

  it("bounds concurrency to the pool size and queues the rest in order", async () => {
    makePool(2);
    const BATCH_MS = 250;
    const started = Date.now();
    const pending = Array.from({ length: 6 }, (_, n) => pool!.embed(request([`doc-${n}`], `trace:${BATCH_MS}`)));
    expect(pool!.queued).toBeLessThanOrEqual(6);
    const results = await Promise.all(pending);
    const elapsed = Date.now() - started;

    const spans = results.map((result, n) => {
      const [length, threadId, start, end] = rows(result.data)[0]!;
      expect(length).toBe(`doc-${n}`.length);
      return { n, threadId: threadId!, start: start!, end: end! };
    });
    expect(new Set(spans.map((span) => span.threadId)).size).toBe(2);
    // One batch at a time per thread...
    for (const threadId of new Set(spans.map((span) => span.threadId))) {
      const own = spans.filter((span) => span.threadId === threadId).sort((a, b) => a.start - b.start);
      for (let i = 1; i < own.length; i++) expect(own[i]!.start).toBeGreaterThanOrEqual(own[i - 1]!.end);
    }
    // ...never more than two in flight overall, and two really do overlap.
    const overlapAt = (time: number) => spans.filter((span) => span.start <= time && time < span.end).length;
    const peak = Math.max(...spans.map((span) => overlapAt(span.start)));
    expect(peak).toBe(2);
    // Three rounds of two (not six serial, not one parallel round).
    expect(elapsed).toBeGreaterThanOrEqual(BATCH_MS * 3 * 0.9);
    expect(elapsed).toBeLessThan(BATCH_MS * 6 * 0.85);
    // FIFO: the first two requests start before any later one.
    const startOrder = [...spans].sort((a, b) => a.start - b.start).map((span) => span.n);
    expect(new Set(startOrder.slice(0, 2))).toEqual(new Set([0, 1]));
  }, 60_000);

  it("keeps the main thread ticking while the pool runs CPU-heavy batches", async () => {
    makePool(2);
    await pool!.preload({ model: "busy:400", dtypes: ["q8"], cacheDir: "/nonexistent", normalize: true });
    const lag = await maxTimerLag(async () => {
      await Promise.all(Array.from({ length: 4 }, (_, n) => pool!.embed(request([`t${n}`, "u"], "busy:400"))));
    });
    console.log(`[local-embedding-pool.test] event-loop lag with 2 pool threads, 4x400ms batches: ${Math.round(lag)}ms`);
    expect(lag).toBeLessThan(200);
  }, 60_000);

  it("rejects a queued request on abort without running it, and a running one without freeing its thread early", async () => {
    makePool(1);
    const running = pool!.embed(request(["first"], "trace:300"));
    const queuedController = new AbortController();
    const queued = pool!.embed(request(["second"], "trace:300"), queuedController.signal);
    const runningController = new AbortController();
    const third = pool!.embed(request(["third"], "trace:300"), runningController.signal);
    expect(pool!.queued).toBe(2);

    queuedController.abort(new Error("stage cancelled"));
    await expect(queued).rejects.toThrow("stage cancelled");
    expect(pool!.queued).toBe(1);

    const [first, thirdResult] = await Promise.all([running, third]);
    expect(rows(first.data)[0]![0]).toBe("first".length);
    expect(rows(thirdResult.data)[0]![0]).toBe("third".length);
    await expect(pool!.embed(request(["x"], "busy:1"), AbortSignal.abort(new Error("already aborted")))).rejects.toThrow("already aborted");
  }, 30_000);

  it("keeps the slot busy until the thread finishes an aborted batch", async () => {
    makePool(1);
    const controller = new AbortController();
    const startedAt = Date.now();
    const aborted = pool!.embed(request(["slow"], "trace:300"), controller.signal);
    const next = pool!.embed(request(["next"], "trace:20"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    controller.abort(new Error("stage cancelled"));
    await expect(aborted).rejects.toThrow("stage cancelled");
    expect(pool!.active).toBe(1);
    expect(pool!.queued).toBe(1);
    await next;
    // The next batch only ran after the aborted one finished on the thread.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300);
  }, 30_000);

  it("propagates model errors to the request and keeps serving", async () => {
    makePool(2);
    await expect(pool!.embed(request(["x"], "fail:model"))).rejects.toThrow("cannot load fail:model");
    expect(pool!.unusable).toBe(false);
    const ok = await pool!.embed(request(["ok"], "busy:1"));
    expect(ok.dims).toEqual([1, 4]);
  }, 30_000);

  it("rejects the in-flight request when a thread crashes, then respawns it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    makePool(1);
    await pool!.embed(request(["warm"], "busy:1"));
    const crashed = pool!.embed(request(["__crash__"], "busy:1"));
    const queuedBehind = pool!.embed(request(["after"], "busy:1"));
    const error = await crashed.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(LocalEmbeddingThreadCrashError);
    expect((error as Error).message).toMatch(/exited unexpectedly with code 7/);
    // The queued request runs on the respawned thread, which reloads the model.
    const recovered = await queuedBehind;
    expect(rows(recovered.data)[0]![0]).toBe("after".length);
    expect(recovered.cacheHit).toBe(false);
    expect(pool!.unusable).toBe(false);
  }, 30_000);

  it("is unusable only when no thread can start", async () => {
    makePool(2, 1, new URL("../test/fixtures/does-not-exist.mjs", import.meta.url).href);
    await expect(pool!.embed(request(["x"], "busy:1"))).rejects.toThrow();
    // The failed request was retried on the other thread before giving up.
    await expect(pool!.embed(request(["x"], "busy:1"))).rejects.toThrow();
    expect(pool!.unusable).toBe(true);
  }, 30_000);

  it("reports the thread's own run and load time, excluding queue wait", async () => {
    makePool(1);
    const first = pool!.embed(request(["a"], "busy:150"));
    const queued = pool!.embed(request(["b"], "busy:150"));
    const [a, b] = await Promise.all([first, queued]);
    expect(a.cacheHit).toBe(false);
    expect(a.runMs).toBeGreaterThanOrEqual(140);
    // The second request waited ~150 ms in the queue but its run time covers only its own batch.
    expect(b.cacheHit).toBe(true);
    expect(b.loadMs).toBe(0);
    expect(b.runMs).toBeGreaterThanOrEqual(140);
    expect(b.runMs).toBeLessThan(290);
    const load = await pool!.embed({ ...request([], "busy:150") });
    expect(load.runMs).toBe(0);
  }, 30_000);

  it("keeps one model per thread: loading another model replaces the first", async () => {
    makePool(1);
    const load = (model: string) => pool!.embed(request([], model));
    expect((await load("busy:1")).cacheHit).toBe(false);
    expect((await load("busy:1")).cacheHit).toBe(true);
    expect((await load("busy:2")).cacheHit).toBe(false);
    // busy:1 was evicted to make room, so it loads again instead of a second copy staying resident.
    expect((await load("busy:1")).cacheHit).toBe(false);
  }, 30_000);

  it("rejects, frees the slot and marks the pool unusable when starting a thread throws synchronously", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      pool = new LocalEmbeddingPool({
        size: 2,
        intraOpThreads: 1,
        moduleUrl: () => {
          throw new Error("cannot resolve @huggingface/transformers");
        },
      });
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, (_, n) => pool!.embed(request([`doc-${n}`], "busy:1"))),
      );
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      expect(String((results[0] as PromiseRejectedResult).reason)).toMatch(/cannot resolve/);
      // Nothing is left running or queued, and the runtime's in-process fallback can engage.
      expect(pool.active).toBe(0);
      expect(pool.queued).toBe(0);
      expect(pool.unusable).toBe(true);
      await expect(pool.embed(request(["later"], "busy:1"))).rejects.toThrow(/could (not )?start/);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  }, 30_000);

  it("settles every queued job when dispatch itself throws", async () => {
    makePool(1);
    const dispatch = vi.spyOn(pool as unknown as { dispatch(): void }, "dispatch");
    const running = pool!.embed(request(["a"], "busy:50"));
    const queued = pool!.embed(request(["b"], "busy:50"));
    dispatch.mockImplementationOnce(() => {
      throw new Error("dispatch exploded");
    });
    await running;
    await expect(queued).rejects.toThrow("dispatch exploded");
    expect(pool!.active).toBe(0);
  }, 30_000);

  it("rejects queued and in-flight requests on close and refuses new ones", async () => {
    makePool(1);
    const running = pool!.embed(request(["a"], "busy:2000"));
    const queued = pool!.embed(request(["b"], "busy:2000"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const closing = pool!.close();
    await expect(queued).rejects.toThrow("closed");
    await expect(running).rejects.toThrow("closed");
    await closing;
    await expect(pool!.embed(request(["c"], "busy:1"))).rejects.toThrow("closed");
  }, 30_000);
});
