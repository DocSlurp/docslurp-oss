/**
 * Prior cost profiles for page-range shards, per stage and executor class.
 *
 * Workflow-safe: constants only. `calibrateShardProfile` refines these from observed shard timings.
 *
 * Sources (performance/pdf-page-sharding-2026-10-28 in the app repo):
 * - per-page and fixed costs: Theil-Sen fits over 14 production PDFs (3-477 pages, 2026-10-27/28) of
 *   checkpoint stage durations; the Doppler VM call is the extract-markdown fit less ~0.6 s of post-VM writes;
 * - memory: VM limits from the Doppler guest (RLIMIT_AS 768 MiB inside a 1 GiB VM) and the worker slot
 *   allocation (2 GB); per-page memory is a conservative prior until shard RSS is observed;
 * - prices: Modal VM ceiling from `dopplerVmUsage`, Fly shared-cpu-8x slot $0.0211/slot-hour.
 */
import type { ShardCapacity, ShardCostProfile } from "./page-shards.js";

const FLY_SLOT_USD_PER_SECOND = 0.0211 / 3600;
const DOPPLER_VM_USD_PER_SECOND = 0.00003942 + 0.00000667;

export const SHARD_PROFILES = {
  /**
   * Offline Doppler VM, 0.5 core with one-core burst, 1 GiB. 32-page alignment keeps output identical to the
   * guest's own chunks; the guest converts 32 pages at a time, so memory does not grow with shard size.
   */
  "extract-markdown:doppler-vm": {
    stage: "extract-markdown", executor: "doppler-vm",
    fixedMs: 1_900, perPageMs: 12.6, baseMiB: 200, perPageMiB: 0, memoryLimitMiB: 768,
    maxShardMs: 90_000, minShardPages: 32, maxShardPages: 10_000, pageAlign: 32,
    usdPerSecond: DOPPLER_VM_USD_PER_SECOND,
  },
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

export type ShardProfileKey = keyof typeof SHARD_PROFILES;

/**
 * Capacity a run can count on. Worker slots: idle slots now, the org's slot share as ceiling, and the
 * machine start time as scale-up delay (prior; not yet measured). Doppler VMs: a provider-side
 * parallelism cap with VM boot already inside `fixedMs`.
 */
export function shardCapacity(
  executor: ShardCostProfile["executor"],
  fleet: { idleSlots: number; orgSlots: number; vmParallel: number; machineStartMs?: number },
): ShardCapacity {
  if (executor === "doppler-vm") {
    const vms = Math.max(1, Math.floor(fleet.vmParallel));
    return { readySlots: vms, maxSlots: vms, scaleUpMs: 0 };
  }
  const ceiling = Math.max(1, Math.floor(fleet.orgSlots));
  return {
    readySlots: Math.max(1, Math.min(ceiling, Math.floor(fleet.idleSlots))),
    maxSlots: ceiling,
    scaleUpMs: Math.max(0, fleet.machineStartMs ?? 30_000),
  };
}
