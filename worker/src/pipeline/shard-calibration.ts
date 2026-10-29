/**
 * STUB: replaced by feat/page-shard-calibration.
 *
 * Contract only, so callers on this branch compile and run: `record` pushes nothing and
 * `calibratedShardProfile` returns the prior. The real module persists shard timings and
 * refits profiles with `calibrateShardProfile`.
 */
import type { ShardCostProfile } from "../temporal/page-shards.js";
import type { WorkflowState } from "./pipeline.js";

export const SHARD_TIMING_METRIC = "shard_timing";

export interface ShardTiming {
  stage: string;
  executor: string;
  documentId: string;
  /** Work units the timing covers: pages for documents, seconds for media windows. */
  pages: number;
  ms: number;
  shardIndex?: number;
  shardCount?: number;
  maxRssMiB?: number;
}

export function recordShardTiming(_state: WorkflowState, _timing: ShardTiming): void {}

export async function calibratedShardProfile(prior: ShardCostProfile): Promise<ShardCostProfile> {
  return prior;
}

export interface ShardCalibration {
  record(state: WorkflowState, timing: ShardTiming): void;
  profile(prior: ShardCostProfile): Promise<ShardCostProfile>;
}

export function createShardCalibration(): ShardCalibration {
  return { record: recordShardTiming, profile: calibratedShardProfile };
}
