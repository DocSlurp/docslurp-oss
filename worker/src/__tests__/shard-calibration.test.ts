import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SHARD_CALIBRATION_TTL_MS,
  SHARD_TIMING_METRIC,
  calibratedShardProfile,
  createShardCalibration,
  recordShardTiming,
  recordShardTimingInContext,
  resetShardCalibrationCache,
} from "../pipeline/shard-calibration.js";
import { SHARD_PROFILES } from "../temporal/page-shard-profiles.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import { runWithPerfContext } from "../lib/perf-context.js";
import type { PerformanceEvent } from "../models.js";

const KEY = "extract-markdown:doppler-vm" as const;
const prior = SHARD_PROFILES[KEY];
const state = () => ({ pendingPerformance: [] }) as unknown as WorkflowState;
const line = (fixedMs: number, perPageMs: number) =>
  [8, 16, 32, 64, 96, 128, 192, 256, 320, 400].map((pages) => ({ pages, ms: fixedMs + pages * perPageMs }));

afterEach(() => {
  resetShardCalibrationCache();
  vi.restoreAllMocks();
});

describe("recordShardTiming", () => {
  it("pushes one document-scoped performance row keyed by profile", () => {
    const s = state();
    recordShardTiming(s, { stage: "extract-markdown", executor: "doppler-vm", documentId: "doc-1", pages: 96, ms: 3_100.4, maxRssMiB: 210, shardIndex: 1, shardCount: 5 });
    expect(s.pendingPerformance).toEqual([{
      documentId: "doc-1", scope: "document", stageName: "extract-markdown", metric: SHARD_TIMING_METRIC, value: 3_100,
      unit: "ms", tags: ["shard", "doppler-vm"],
      metadata: { executor: "doppler-vm", pages: 96, profileKey: KEY, maxRssMiB: 210, shardIndex: 1, shardCount: 5 },
    }]);
  });

  it("drops rows that cannot calibrate anything", () => {
    const s = state();
    recordShardTiming(s, { stage: "embed", executor: "fly-shared-slot", documentId: "d", pages: 0, ms: 10 });
    recordShardTiming(s, { stage: "embed", executor: "fly-shared-slot", documentId: "d", pages: 4, ms: Number.NaN });
    expect(s.pendingPerformance).toHaveLength(0);
  });
});

describe("recordShardTimingInContext", () => {
  it("writes the same metric and profile key through the active perf context", async () => {
    const events: PerformanceEvent[] = [];
    await runWithPerfContext({ runId: "r", scope: "document", stageName: "extract-markdown", documentId: "doc-9", pushPerformance: (e) => events.push(e) }, async () => {
      recordShardTimingInContext({ stage: "extract-markdown", executor: "doppler-vm", pages: 32, ms: 2_300, shardIndex: 0, shardCount: 3 });
    });
    const s = state();
    recordShardTiming(s, { stage: "extract-markdown", executor: "doppler-vm", documentId: "doc-9", pages: 32, ms: 2_300, shardIndex: 0, shardCount: 3 });
    expect(events).toEqual(s.pendingPerformance);
  });

  it("is a no-op outside a perf context", () => {
    expect(() => recordShardTimingInContext({ stage: "embed", executor: "fly-shared-slot", pages: 8, ms: 10 })).not.toThrow();
  });
});

describe("calibratedShardProfile", () => {
  it("returns the prior when the loader fails, warning once per period", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let now = 0;
    const loadObservations = vi.fn(async () => { throw new Error("db down"); });
    expect(await calibratedShardProfile(KEY, { loadObservations, now: () => now })).toBe(prior);
    now += 1_000; // within the period: cached prior, no reload, no second warning
    expect(await calibratedShardProfile(KEY, { loadObservations, now: () => now })).toBe(prior);
    expect(loadObservations).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    now += SHARD_CALIBRATION_TTL_MS + 1; // next period retries and warns once more
    expect(await calibratedShardProfile(KEY, { loadObservations, now: () => now })).toBe(prior);
    expect(loadObservations).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("returns the prior when there are too few points", async () => {
    const loadObservations = vi.fn(async () => [{ pages: 32, ms: 1_000 }, { pages: 64, ms: 2_000 }]);
    expect(await calibratedShardProfile(KEY, { loadObservations })).toBe(prior);
  });

  it("caches within the TTL and refreshes after it", async () => {
    let now = 1_000;
    const loadObservations = vi.fn(async () => line(1_000, 20));
    const first = await calibratedShardProfile(KEY, { loadObservations, now: () => now });
    now += SHARD_CALIBRATION_TTL_MS - 1;
    expect(await calibratedShardProfile(KEY, { loadObservations, now: () => now })).toBe(first);
    expect(loadObservations).toHaveBeenCalledTimes(1);
    now += 2;
    await calibratedShardProfile(KEY, { loadObservations, now: () => now });
    expect(loadObservations).toHaveBeenCalledTimes(2);
    expect(loadObservations).toHaveBeenLastCalledWith(KEY, 200);
  });

  it("moves the profile toward observed timings", async () => {
    const profile = await calibratedShardProfile(KEY, { loadObservations: async () => line(1_000, 20) });
    expect(profile.perPageMs).toBeGreaterThan(prior.perPageMs);
    expect(profile.perPageMs).toBeLessThan(20);
    expect(profile.fixedMs).toBeLessThan(prior.fixedMs);
    expect(profile.fixedMs).toBeGreaterThan(1_000);
  });
});

describe("createShardCalibration", () => {
  it("uses priors without a store that can load observations", async () => {
    expect(await createShardCalibration(undefined).profile(KEY)).toBe(prior);
    expect(await createShardCalibration({}).profile(KEY)).toBe(prior);
  });

  it("reads through the store", async () => {
    const store = { loadShardObservations: vi.fn(async () => line(500, 30)) };
    const profile = await createShardCalibration(store).profile(KEY);
    expect(store.loadShardObservations).toHaveBeenCalledWith(KEY, 200);
    expect(profile.perPageMs).toBeGreaterThan(prior.perPageMs);
  });
});
