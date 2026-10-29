import { describe, expect, it } from "vitest";
import {
  calibrateShardProfile,
  pageRanges,
  planPageShards,
  theilSen,
  type ShardCostProfile,
} from "../temporal/page-shards.js";

const vm: ShardCostProfile = {
  stage: "extract-markdown",
  executor: "doppler-vm",
  fixedMs: 2_000,
  perPageMs: 15,
  baseMiB: 200,
  perPageMiB: 1,
  memoryLimitMiB: 768,
  maxShardMs: 120_000,
  minShardPages: 8,
  maxShardPages: 10_000,
  pageAlign: 32,
  usdPerSecond: 0.00004609,
};
const budget = { maxCostOverhead: 1, maxShards: 64 };

describe("pageRanges", () => {
  it("covers every page once, in order", () => {
    expect(pageRanges(65, 32)).toEqual([{ first: 1, last: 32 }, { first: 33, last: 64 }, { first: 65, last: 65 }]);
    expect(pageRanges(3, 32)).toEqual([{ first: 1, last: 3 }]);
  });
});

describe("planPageShards", () => {
  it("leaves short documents whole", () => {
    const plan = planPageShards(20, vm, { readySlots: 8, maxSlots: 8, scaleUpMs: 0 }, budget);
    expect(plan.shards).toEqual([{ first: 1, last: 20 }]);
    expect(plan.reason).toMatch(/unsharded/);
  });

  it("fans a long document out across ready executors on aligned boundaries", () => {
    const plan = planPageShards(477, vm, { readySlots: 16, maxSlots: 16, scaleUpMs: 0 }, budget);
    expect(plan.shardPages % 32).toBe(0);
    expect(plan.shards.length).toBeGreaterThan(1);
    expect(plan.shards.length).toBeLessThanOrEqual(16);
    expect(plan.shards.at(-1)!.last).toBe(477);
    expect(plan.predictedWallMs).toBeLessThan(plan.unshardedWallMs / 2);
  });

  it("does not shard when only one executor is available", () => {
    const plan = planPageShards(477, vm, { readySlots: 1, maxSlots: 1, scaleUpMs: 0 }, budget);
    expect(plan.shards).toHaveLength(1);
  });

  it("waits for a scale-up only when it beats the ready executors", () => {
    const fast = planPageShards(990, vm, { readySlots: 1, maxSlots: 32, scaleUpMs: 1_000 }, budget);
    expect(fast.needsScaleUp).toBe(true);
    const slow = planPageShards(990, vm, { readySlots: 1, maxSlots: 32, scaleUpMs: 600_000 }, budget);
    expect(slow.needsScaleUp).toBe(false);
  });

  it("respects the cost overhead budget", () => {
    const tight = planPageShards(477, vm, { readySlots: 64, maxSlots: 64, scaleUpMs: 0 }, { maxCostOverhead: 0.1, maxShards: 64 });
    expect(tight.predictedCostUsd / tight.unshardedCostUsd - 1).toBeLessThanOrEqual(0.1);
    const loose = planPageShards(477, vm, { readySlots: 64, maxSlots: 64, scaleUpMs: 0 }, budget);
    expect(loose.shards.length).toBeGreaterThan(tight.shards.length);
  });

  it("splits documents that exceed executor memory or time even without spare capacity", () => {
    const small = { ...vm, perPageMiB: 4, pageAlign: 1 };
    const plan = planPageShards(400, small, { readySlots: 1, maxSlots: 1, scaleUpMs: 0 }, budget);
    expect(plan.shardPages).toBeLessThanOrEqual(142);
    expect(plan.shards.at(-1)!.last).toBe(400);
    const slow = { ...vm, perPageMs: 1_000, pageAlign: 1 };
    const timed = planPageShards(400, slow, { readySlots: 1, maxSlots: 1, scaleUpMs: 0 }, budget);
    expect(timed.shardPages).toBeLessThanOrEqual(118);
  });

  it("prefers fewer shards when more would barely help", () => {
    const plan = planPageShards(477, { ...vm, fixedMs: 0, perPageMs: 15 }, { readySlots: 64, maxSlots: 64, scaleUpMs: 0 }, {
      ...budget, wallTolerance: 1,
    });
    const strict = planPageShards(477, { ...vm, fixedMs: 0, perPageMs: 15 }, { readySlots: 64, maxSlots: 64, scaleUpMs: 0 }, {
      ...budget, wallTolerance: 0,
    });
    expect(plan.shards.length).toBeLessThan(strict.shards.length);
  });

  it("is deterministic", () => {
    const capacity = { readySlots: 5, maxSlots: 40, scaleUpMs: 4_000 };
    expect(planPageShards(1234, vm, capacity, budget)).toEqual(planPageShards(1234, vm, capacity, budget));
  });
});

describe("calibrateShardProfile", () => {
  it("recovers fixed and per-page cost despite an outlier", () => {
    const obs = [3, 80, 80, 80, 477, 477, 477, 67].map((pages, i) => ({ pages, ms: i === 7 ? 11_000 : 1_900 + 15 * pages }));
    const fit = theilSen(obs.map((o) => ({ x: o.pages, y: o.ms })))!;
    expect(fit.slope).toBeCloseTo(15, 0);
    const next = calibrateShardProfile({ ...vm, fixedMs: 2_500, perPageMs: 20 }, obs, 0);
    expect(next.perPageMs).toBeCloseTo(15, 0);
    expect(next.fixedMs).toBeGreaterThan(1_500);
    expect(next.fixedMs).toBeLessThan(2_500);
  });

  it("ignores fits from one document's near-identical shards", () => {
    const obs = [96, 96, 96, 96, 93].map((pages, i) => ({ pages, ms: 1_900 + 12.6 * pages + (i % 2 ? 300 : -300) }));
    expect(calibrateShardProfile(vm, obs, 0)).toBe(vm);
  });

  it("clamps fleet-wide observations to a band around the prior", () => {
    const poisoned = [8, 16, 32, 64, 128].map((pages) => ({ pages, ms: pages * 400 }));
    const next = calibrateShardProfile(vm, poisoned, 0);
    expect(next.fixedMs).toBeGreaterThanOrEqual(vm.fixedMs * 0.5);
    expect(next.perPageMs).toBeLessThanOrEqual(vm.perPageMs * 3);
  });

  it("keeps the prior until there is enough spread to fit", () => {
    expect(calibrateShardProfile(vm, [{ pages: 80, ms: 1 }, { pages: 80, ms: 2 }, { pages: 80, ms: 3 }])).toBe(vm);
    expect(calibrateShardProfile(vm, [{ pages: 1, ms: 1 }])).toBe(vm);
  });

  it("never calibrates memory below the prior", () => {
    const obs = [10, 20, 30, 40].map((pages) => ({ pages, ms: 2_000 + pages * 15, maxRssMiB: 50 + pages * 0.1 }));
    const next = calibrateShardProfile(vm, obs, 0);
    expect(next.perPageMiB).toBe(vm.perPageMiB);
    expect(next.baseMiB).toBe(vm.baseMiB);
  });
});

describe("calibrated priors", () => {
  it("fans long PDFs out across Doppler VMs and leaves short ones whole", async () => {
    const { SHARD_PROFILES, shardCapacity } = await import("../temporal/page-shard-profiles.js");
    const profile = SHARD_PROFILES["extract-markdown:doppler-vm"];
    const capacity = shardCapacity("doppler-vm", { idleSlots: 0, orgSlots: 0, vmParallel: 16 });
    const short = planPageShards(21, profile, capacity, { maxCostOverhead: 1, maxShards: 32 });
    expect(short.shards).toHaveLength(1);
    const long = planPageShards(477, profile, capacity, { maxCostOverhead: 1, maxShards: 32 });
    expect(long.shardPages % 32).toBe(0);
    expect(long.predictedWallMs).toBeLessThan(long.unshardedWallMs / 2);
    // The production 477-page VM call took ~7.6-10.3 s; the prior predicts the same order of magnitude unsharded.
    expect(long.unshardedWallMs).toBeGreaterThan(6_000);
    expect(long.unshardedWallMs).toBeLessThan(10_000);
  });
});
