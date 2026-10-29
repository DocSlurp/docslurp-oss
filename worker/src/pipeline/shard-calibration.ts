/**
 * Feeds observed page-shard timings back into the shard planner's cost profiles.
 *
 * Every executed shard records one `shard_timing_ms` performance row (pages, wall ms, peak RSS);
 * planning reads the newest rows for its `${stage}:${executor}` profile and refits the prior with
 * `calibrateShardProfile`. Calibration is advisory: a missing store, a failed query or too few
 * samples returns the prior, so planning never fails because measurements are unavailable.
 */
import { currentPerfContext } from "../lib/perf-context.js";
import type { JsonMap } from "../models.js";
import { calibrateShardProfile, type ShardCostProfile, type ShardObservation } from "../temporal/page-shards.js";
import { SHARD_PROFILES, type ShardProfileKey } from "../temporal/page-shard-profiles.js";
import type { WorkflowState } from "./pipeline.js";

export const SHARD_TIMING_METRIC = "shard_timing_ms";
export const SHARD_CALIBRATION_TTL_MS = 10 * 60_000;
export const SHARD_OBSERVATION_LIMIT = 200;

export interface ShardTimingRow {
  stage: string;
  executor: string;
  documentId: string;
  pages: number;
  ms: number;
  maxRssMiB?: number;
  shardIndex?: number;
  shardCount?: number;
}

export function shardProfileKey(stage: string, executor: string): string {
  return `${stage}:${executor}`;
}

function timingMetadata(row: Omit<ShardTimingRow, "documentId">): JsonMap | null {
  if (!(row.pages > 0) || !Number.isFinite(row.ms) || row.ms < 0) return null;
  const metadata: JsonMap = {
    executor: row.executor,
    pages: row.pages,
    profileKey: shardProfileKey(row.stage, row.executor),
  };
  if (row.maxRssMiB !== undefined && Number.isFinite(row.maxRssMiB)) metadata.maxRssMiB = row.maxRssMiB;
  if (row.shardIndex !== undefined) metadata.shardIndex = row.shardIndex;
  if (row.shardCount !== undefined) metadata.shardCount = row.shardCount;
  return metadata;
}

/** One performance row per executed shard; persisted with the stage's checkpoint. */
export function recordShardTiming(state: WorkflowState, row: ShardTimingRow): void {
  const metadata = timingMetadata(row);
  if (!metadata) return;
  state.pendingPerformance.push({
    documentId: row.documentId,
    scope: "document",
    stageName: row.stage,
    metric: SHARD_TIMING_METRIC,
    value: Math.round(row.ms),
    unit: "ms",
    tags: ["shard", row.executor],
    metadata,
  });
}

/**
 * The same row for code without a WorkflowState (tools/runner, sandbox providers): written through the
 * active perf context, which supplies scope and stage name (and the document unless `documentId` is given).
 * The loader keys on metric and `metadata.profileKey`, so both paths calibrate the same profile. No-op
 * outside a perf context.
 */
export function recordShardTimingInContext(row: Omit<ShardTimingRow, "documentId"> & { documentId?: string }): void {
  const context = currentPerfContext();
  const metadata = timingMetadata(row);
  if (!context || !metadata) return;
  context.pushPerformance({
    documentId: row.documentId ?? context.documentId,
    scope: context.scope,
    stageName: context.stageName,
    metric: SHARD_TIMING_METRIC,
    value: Math.round(row.ms),
    unit: "ms",
    tags: ["shard", row.executor],
    metadata,
  });
}

export type LoadShardObservations = (profileKey: string, limit: number) => Promise<ShardObservation[]>;

type CacheEntry = { at: number; profile: ShardCostProfile };
const cache = new Map<string, CacheEntry>();
const warned = new Map<string, number>();

/** Test hook: forget cached profiles and warnings. */
export function resetShardCalibrationCache(): void {
  cache.clear();
  warned.clear();
}

export async function calibratedShardProfile(
  key: ShardProfileKey,
  deps: { loadObservations: LoadShardObservations; now?: () => number },
): Promise<ShardCostProfile> {
  const now = (deps.now ?? Date.now)();
  const hit = cache.get(key);
  if (hit && now - hit.at < SHARD_CALIBRATION_TTL_MS) return hit.profile;
  const prior: ShardCostProfile = SHARD_PROFILES[key];
  let profile = prior;
  try {
    profile = calibrateShardProfile(prior, await deps.loadObservations(key, SHARD_OBSERVATION_LIMIT));
  } catch (error) {
    const last = warned.get(key);
    if (last === undefined || now - last >= SHARD_CALIBRATION_TTL_MS) {
      warned.set(key, now);
      console.warn(`[shard-calibration] profile=${key} using prior: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  cache.set(key, { at: now, profile });
  return profile;
}

export interface ShardCalibration {
  profile(key: ShardProfileKey): Promise<ShardCostProfile>;
  record(state: WorkflowState, row: ShardTimingRow): void;
}

/** Store-backed calibration; without a store that can load observations every profile is its prior. */
export function createShardCalibration(
  store: { loadShardObservations?: LoadShardObservations } | undefined,
  now?: () => number,
): ShardCalibration {
  const load = store?.loadShardObservations?.bind(store);
  return {
    profile: (key) => load
      ? calibratedShardProfile(key, { loadObservations: load, ...(now ? { now } : {}) })
      : Promise.resolve(SHARD_PROFILES[key]),
    record: recordShardTiming,
  };
}
