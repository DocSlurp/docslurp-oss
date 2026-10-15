import { afterEach, describe, expect, it } from "vitest";

import { LocalEmbeddingThread, localEmbeddingThreadEnabled } from "../stages/local-embedding-thread.js";

/**
 * Local embedding runs on a worker thread so a CPU-bound batch cannot block
 * the event loop (heartbeats, Postgres connects, workflow tasks). The fixture
 * blocks its thread synchronously per batch, as onnxruntime-node does.
 */
const busyModuleUrl = new URL("../test/fixtures/busy-transformers.mjs", import.meta.url).href;
const BUSY_MS = 400;
const request = (texts: string[], model = `busy:${BUSY_MS}`) => ({
  model, dtypes: ["q8", "fp32"], cacheDir: "/nonexistent", texts, normalize: true,
});

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
    // A loop blocked to the end never ran the timer: count the final gap too.
    worst = Math.max(worst, performance.now() - last - 10);
  } finally {
    clearInterval(timer);
  }
  return worst;
}

let thread: LocalEmbeddingThread | null = null;
afterEach(async () => {
  await thread?.close();
  thread = null;
});

describe("local embedding thread", () => {
  it("is on unless DOCSLURP_LOCAL_EMBED_THREAD turns it off", () => {
    expect(localEmbeddingThreadEnabled({})).toBe(true);
    expect(localEmbeddingThreadEnabled({ DOCSLURP_LOCAL_EMBED_THREAD: "on" })).toBe(true);
    expect(localEmbeddingThreadEnabled({ DOCSLURP_LOCAL_EMBED_THREAD: "off" })).toBe(false);
    expect(localEmbeddingThreadEnabled({ DOCSLURP_LOCAL_EMBED_THREAD: "false" })).toBe(false);
  });

  it("returns the pipeline's vectors and dims", async () => {
    thread = new LocalEmbeddingThread(() => busyModuleUrl);
    const first = await thread.embed(request(["ab", "abcd"], "busy:1"));
    expect(first.dims).toEqual([2, 4]);
    expect(Array.from(first.data)).toEqual([2, 2, 2, 2, 4, 4, 4, 4]);
    expect(first.dtype).toBe("q8");
    expect(first.cacheHit).toBe(false);
    const second = await thread.embed(request(["x"], "busy:1"));
    expect(second.cacheHit).toBe(true);
    // No texts: load only.
    const load = await thread.embed(request([], "busy:2"));
    expect(load).toMatchObject({ dims: [0], dtype: "q8", cacheHit: false });
    expect(load.data).toHaveLength(0);
  }, 30_000);

  it("keeps the event loop responsive while a batch blocks (before: in-process lag ~ batch time)", async () => {
    const { pipeline } = await import(busyModuleUrl) as {
      pipeline: (task: string, model: string) => Promise<(texts: string[]) => Promise<unknown>>;
    };
    const inProcess = await pipeline("feature-extraction", `busy:${BUSY_MS}`);
    const inProcessLag = await maxTimerLag(async () => {
      for (let batch = 0; batch < 3; batch++) await inProcess(["a", "b"]);
    });

    thread = new LocalEmbeddingThread(() => busyModuleUrl);
    await thread.embed(request(["warm"], "busy:1"));
    const threadLag = await maxTimerLag(async () => {
      for (let batch = 0; batch < 3; batch++) await thread!.embed(request(["a", "b"]));
    });

    console.log(`[local-embedding-thread.test] event-loop lag in-process=${Math.round(inProcessLag)}ms thread=${Math.round(threadLag)}ms batch=${BUSY_MS}ms`);
    expect(inProcessLag).toBeGreaterThanOrEqual(BUSY_MS * 0.8);
    expect(threadLag).toBeLessThan(BUSY_MS / 2);
  }, 60_000);

  it("rejects a waiting caller on abort and keeps serving later requests", async () => {
    thread = new LocalEmbeddingThread(() => busyModuleUrl);
    const controller = new AbortController();
    const pending = thread.embed(request(["slow"]), controller.signal);
    setTimeout(() => controller.abort(new Error("stage cancelled")), 20);
    await expect(pending).rejects.toThrow("stage cancelled");
    const next = await thread.embed(request(["ok"], "busy:1"));
    expect(next.dims).toEqual([1, 4]);
  }, 30_000);

  it("reports model load errors per request without marking the thread unusable", async () => {
    thread = new LocalEmbeddingThread(() => busyModuleUrl);
    await expect(thread.embed(request(["x"], "fail:model"))).rejects.toThrow("cannot load fail:model");
    expect(thread.unusable).toBe(false);
  }, 30_000);

  it("marks the thread unusable when it cannot start, so callers fall back in-process", async () => {
    thread = new LocalEmbeddingThread(() => new URL("../test/fixtures/does-not-exist.mjs", import.meta.url).href);
    await expect(thread.embed(request(["x"], "busy:1"))).rejects.toThrow();
    expect(thread.unusable).toBe(true);
  }, 30_000);
});
