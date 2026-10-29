import { planPageShards, type ShardCostProfile } from "../temporal/page-shards.js";
import { shardCapacity } from "../temporal/page-shard-profiles.js";
import type { PageRangeShardPlan, PageRangeSlice } from "../temporal/shared.js";

export interface PageRangePlanDocument {
  id: string;
  pageCount: number;
  mimeType?: string | null;
  /** Already completed for this stage: never sharded again. */
  completed?: boolean;
}

/**
 * Page-range shards for one stage of a run: long documents first, each planned with the
 * calibrated profile, all sharing the run's shard budget. Capacity is the recorded org slot
 * share; the slot gate (AIMD backoff) and the autoscaler absorb any shortfall at dispatch.
 * Returns no shards when nothing is worth splitting.
 */
export function planRunPageRanges(args: {
  documents: readonly PageRangePlanDocument[];
  profile: ShardCostProfile;
  maxShards: number;
  maxCostOverhead?: number;
}): PageRangeShardPlan {
  const budget = Math.max(0, Math.floor(args.maxShards));
  if (budget < 2) return { shards: [] };
  const candidates = args.documents
    .filter((document) => document.mimeType === "application/pdf" && !document.completed && Math.floor(document.pageCount) > 1)
    .sort((a, b) => b.pageCount - a.pageCount || a.id.localeCompare(b.id));
  const shards: PageRangeSlice[][] = [];
  let remaining = budget;
  for (const document of candidates) {
    if (remaining < 2) break;
    const capacity = shardCapacity(args.profile.executor, { idleSlots: remaining, orgSlots: remaining, vmParallel: remaining });
    const plan = planPageShards(Math.floor(document.pageCount), args.profile, capacity, {
      maxCostOverhead: args.maxCostOverhead ?? 1,
      maxShards: remaining,
    });
    if (plan.shards.length < 2) continue;
    for (const range of plan.shards) shards.push([{ documentId: document.id, first: range.first, last: range.last }]);
    remaining -= plan.shards.length;
  }
  return { shards: shards.length > 1 ? shards : [] };
}
