/**
 * Prior cost profiles for page-range shards, per stage and executor class.
 *
 * Workflow-safe: constants only. `calibrateShardProfile` refines these from observed shard timings. An extractor
 * plugin that shards its own work registers its prior with `registerShardProfile` at worker startup.
 *
 * Sources (performance/pdf-page-sharding-2026-10-28 in the app repo):
 * - per-page and fixed costs: Theil-Sen fits over 14 production PDFs (3-477 pages, 2026-10-27/28) of
 *   checkpoint stage durations;
 * - memory: the worker slot allocation (2 GB); per-page memory is a conservative prior until shard RSS is observed;
 * - prices: Fly shared-cpu-8x slot $0.0211/slot-hour.
 */
import type { ShardCapacity, ShardCostProfile } from "./page-shards.js";

const FLY_SLOT_USD_PER_SECOND = 0.0211 / 3600;

export const SHARD_PROFILES = {
  /** Page probe on a worker slot (1 vCPU / 2 GB on shared-cpu-8x); fixed cost is the shard activity boundary. */
  "route-pages:fly-shared-slot": {
    stage: "route-pages", executor: "fly-shared-slot",
    fixedMs: 3_000, perPageMs: 52.8, baseMiB: 300, perPageMiB: 1, memoryLimitMiB: 1_600,
    maxShardMs: 240_000, minShardPages: 16, maxShardPages: 2_000, pageAlign: 8,
    usdPerSecond: FLY_SLOT_USD_PER_SECOND,
  },
  "render-images:fly-shared-slot": {
    stage: "render-images", executor: "fly-shared-slot",
    // Memory per page is unmeasured: 0 so a guess cannot force splits (calibration raises it once RSS is recorded).
    fixedMs: 3_000, perPageMs: 6.5, baseMiB: 300, perPageMiB: 0, memoryLimitMiB: 1_600,
    maxShardMs: 240_000, minShardPages: 64, maxShardPages: 2_000, pageAlign: 8,
    usdPerSecond: FLY_SLOT_USD_PER_SECOND,
  },
  "embed:fly-shared-slot": {
    stage: "embed", executor: "fly-shared-slot",
    fixedMs: 3_000, perPageMs: 22.4, baseMiB: 400, perPageMiB: 1, memoryLimitMiB: 1_600,
    maxShardMs: 240_000, minShardPages: 32, maxShardPages: 4_000, pageAlign: 8,
    usdPerSecond: FLY_SLOT_USD_PER_SECOND,
  },
} as const satisfies Record<string, ShardCostProfile>;

/** A built-in profile key, or one a plugin registered. */
export type ShardProfileKey = keyof typeof SHARD_PROFILES | (string & {});

const registeredProfiles = new Map<string, ShardCostProfile>();

/** Add a plugin's prior. Built-in keys cannot be replaced, and a key keeps its first profile (re-registering the same values is a no-op). */
export function registerShardProfile(key: string, profile: ShardCostProfile): void {
  if (!/^[a-z0-9-]+:[a-z0-9-]+$/.test(key) || Object.hasOwn(SHARD_PROFILES, key)) throw new Error(`Invalid shard profile key ${key}`);
  const existing = registeredProfiles.get(key);
  if (existing && JSON.stringify(existing) !== JSON.stringify(profile)) throw new Error(`Shard profile ${key} is already registered`);
  if (!existing) registeredProfiles.set(key, profile);
}

/** The prior for a key; unknown keys throw rather than plan from a guess. */
export function shardProfile(key: ShardProfileKey): ShardCostProfile {
  const profile = (SHARD_PROFILES as Record<string, ShardCostProfile>)[key] ?? registeredProfiles.get(key);
  if (!profile) throw new Error(`Unknown shard profile ${key}`);
  return profile;
}

/**
 * Capacity a run can count on on worker slots: idle slots now, the org's slot share as ceiling, and the machine start
 * time as scale-up delay (prior; not yet measured). An executor outside the worker fleet (a provider's VMs) sets its
 * own capacity.
 */
export function shardCapacity(
  _executor: ShardCostProfile["executor"],
  fleet: { idleSlots: number; orgSlots: number; machineStartMs?: number },
): ShardCapacity {
  const ceiling = Math.max(1, Math.floor(fleet.orgSlots));
  return {
    readySlots: Math.max(1, Math.min(ceiling, Math.floor(fleet.idleSlots))),
    maxSlots: ceiling,
    scaleUpMs: Math.max(0, fleet.machineStartMs ?? 30_000),
  };
}
