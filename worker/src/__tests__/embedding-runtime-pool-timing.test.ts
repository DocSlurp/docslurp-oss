import { afterEach, describe, expect, it, vi } from "vitest";

import { fromEnv } from "../config.js";
import type { EmbeddingProfile } from "../models.js";
import { embedTextChunks } from "../stages/embedding-runtime.js";

/**
 * With the thread pool, `pool.embed()` wall time includes queueing behind other documents and model
 * loads. Batch-size tuning and `model_load_ms` must use the thread's own measured times instead.
 */
const poolMock = vi.hoisted(() => ({
  unusable: false,
  /** Wall-clock delay of every call (queue wait), independent of the reported thread times. */
  queueDelayMs: 0,
  embed: vi.fn(),
}));

vi.mock("../stages/local-embedding-thread.js", () => ({
  localEmbeddingThreadEnabled: () => true,
  sharedLocalEmbeddingPool: () => poolMock,
  closeSharedLocalEmbeddingPool: async () => undefined,
}));

const profile: EmbeddingProfile = {
  profile: "good-fast-local", target: "local", modelUri: "llm://transformers.js/Xenova/bge-m3", runtime: "local",
  provider: "transformers.js", model: "Xenova/bge-m3", baseUrl: null, dimensions: 4,
  task: "document", normalize: true, batchSize: 4, lateChunking: false, lateChunkingWindow: 2,
};

const env = {
  slow: process.env.DOCSLURP_EMBED_SLOW_BATCH_MS,
  fast: process.env.DOCSLURP_EMBED_FAST_BATCH_MS,
  min: process.env.DOCSLURP_EMBED_MIN_BATCH_SIZE,
};
afterEach(() => {
  vi.restoreAllMocks();
  poolMock.embed.mockReset();
  poolMock.queueDelayMs = 0;
  for (const [key, value] of [["DOCSLURP_EMBED_SLOW_BATCH_MS", env.slow], ["DOCSLURP_EMBED_FAST_BATCH_MS", env.fast], ["DOCSLURP_EMBED_MIN_BATCH_SIZE", env.min]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

function installPool(thread: { loadMs: number; runMs: number; cacheHit?: boolean }) {
  // Advance the clock at the pool boundary: real timers can fire a millisecond
  // early, and this test measures accounting rather than timer precision.
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  poolMock.embed.mockImplementation(async (request: { texts: string[] }) => {
    now += poolMock.queueDelayMs;
    const rows = request.texts.length;
    return {
      data: new Float32Array(rows * 4).fill(1), dims: [rows, 4], dtype: "q8",
      cacheHit: thread.cacheHit ?? true,
      loadMs: request.texts.length === 0 ? thread.loadMs : 0,
      runMs: request.texts.length === 0 ? 0 : thread.runMs,
    };
  });
}

async function embed(chunks: string[]) {
  const batchSizes: number[] = [];
  const durations: number[] = [];
  const result = await embedTextChunks({
    privacyMode: "standard", chunks, profile, config: fromEnv(),
    onBatchComplete: ({ batchSize, durationMs }) => {
      batchSizes.push(batchSize);
      durations.push(durationMs);
    },
  });
  return { result, batchSizes, durations };
}

describe("local embedding timing on the thread pool", () => {
  it("does not shrink batches because requests queued behind other documents", async () => {
    process.env.DOCSLURP_EMBED_SLOW_BATCH_MS = "100";
    process.env.DOCSLURP_EMBED_FAST_BATCH_MS = "1";
    installPool({ loadMs: 0, runMs: 10 });
    poolMock.queueDelayMs = 150; // wall time per call is above the slow threshold; thread time is not
    const { batchSizes, durations, result } = await embed(Array.from({ length: 16 }, (_, i) => `chunk ${i}`));
    expect(durations).toEqual(batchSizes.map(() => 10));
    // Compute is between the slow and fast thresholds, so the size must stay put.
    expect(new Set(batchSizes)).toEqual(new Set([4]));
    expect(result.vectors).toHaveLength(16);
  }, 30_000);

  it("still halves the batch size when the thread's own run time is slow", async () => {
    process.env.DOCSLURP_EMBED_SLOW_BATCH_MS = "100";
    process.env.DOCSLURP_EMBED_MIN_BATCH_SIZE = "1";
    installPool({ loadMs: 0, runMs: 500 });
    const { batchSizes } = await embed(Array.from({ length: 12 }, (_, i) => `chunk ${i}`));
    expect(batchSizes.slice(0, 2)).toEqual([4, 2]);
  }, 30_000);

  it("reports the thread's model load time, not the time the load request waited in the queue", async () => {
    installPool({ loadMs: 7, runMs: 5, cacheHit: false });
    poolMock.queueDelayMs = 120;
    const { result } = await embed(["a", "b"]);
    expect(result.usage.model_load_ms).toBe(7);
    expect(result.usage.cache_hit).toBe(false);
    expect(result.usage.inference_run_ms).toBe(5);
    expect(result.usage.inference_ms).toBe(120);
  }, 30_000);

  it("counts a load a batch triggered on a cold thread as load, not inference", async () => {
    poolMock.embed.mockImplementation(async (request: { texts: string[] }) => ({
      data: new Float32Array(request.texts.length * 4).fill(1), dims: [request.texts.length, 4], dtype: "q8", cacheHit: false,
      loadMs: request.texts.length === 0 ? 3 : 40, runMs: request.texts.length === 0 ? 0 : 6,
    }));
    const { result, durations } = await embed(["a", "b"]);
    expect(result.usage.model_load_ms).toBe(43);
    expect(durations).toEqual([6]);
  }, 30_000);
});
