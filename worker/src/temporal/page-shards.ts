/**
 * Splits one long document into page-range shards for a stage, sized from a cost model.
 *
 * Workflow-safe: pure and deterministic, no I/O and no Temporal imports.
 *
 * `document-shards.ts` balances whole documents across machines; a single 500-page PDF still
 * lands on one executor. This plans page ranges inside one document instead. A shard costs a
 * fixed overhead (dispatch, source fetch, open, VM boot) plus per-page work, so the shard size
 * is the smallest that keeps the overhead affordable while filling the executors the run can
 * actually get (ready now, or after a scale-up).
 */

/** Measured cost of one stage on one executor class. */
export interface ShardCostProfile {
  stage: string;
  /** Executor class, e.g. `doppler-vm` or `fly-shared-1vcpu-2gb`. */
  executor: string;
  /** Per-shard overhead: dispatch, source fetch and open, VM boot. */
  fixedMs: number;
  perPageMs: number;
  baseMiB: number;
  perPageMiB: number;
  /** Executor memory ceiling (shards must fit with headroom already applied). */
  memoryLimitMiB: number;
  /** Longest shard worth risking: keeps each attempt well inside its timeout. */
  maxShardMs: number;
  minShardPages: number;
  maxShardPages: number;
  /** Shard sizes are multiples of this (e.g. the extractor's internal chunk, so output stays identical). */
  pageAlign?: number;
  /** Executor price while a shard runs. */
  usdPerSecond: number;
}

export interface ShardCapacity {
  /** Executors that can start a shard now. */
  readySlots: number;
  /** Most executors this run may use (autoscale ceiling, provider limit and org fairness applied). */
  maxSlots: number;
  /** Time for executors beyond `readySlots` to become ready. */
  scaleUpMs: number;
}

export interface PageShardOptions {
  /** Most fixed overhead added by sharding, as a fraction of the unsharded cost (0.25 = at most 25 % dearer). */
  maxCostOverhead: number;
  /** Fewer shards win when their predicted wall time is within this fraction of the fastest plan. */
  wallTolerance?: number;
  maxShards: number;
}

export interface PageRange {
  first: number;
  last: number;
}

export interface PageShardPlan {
  shardPages: number;
  shards: PageRange[];
  /** Executors the plan expects to occupy at once. */
  parallel: number;
  /** True when the plan counts on executors beyond `readySlots`. */
  needsScaleUp: boolean;
  predictedWallMs: number;
  unshardedWallMs: number;
  predictedCostUsd: number;
  unshardedCostUsd: number;
  reason: string;
}

const ceilDiv = (a: number, b: number) => Math.ceil(a / b);

export function pageRanges(pageCount: number, shardPages: number): PageRange[] {
  const n = Math.max(0, Math.floor(pageCount));
  const k = Math.max(1, Math.floor(shardPages));
  const out: PageRange[] = [];
  for (let first = 1; first <= n; first += k) out.push({ first, last: Math.min(n, first + k - 1) });
  return out;
}

function shardMs(profile: ShardCostProfile, pages: number): number {
  return profile.fixedMs + pages * profile.perPageMs;
}

/** Wall time of `shards` shards of `k` pages on up to `slots` executors, the last `slots - ready` arriving after scale-up. */
function wallFor(profile: ShardCostProfile, pageCount: number, k: number, slots: number, ready: number, scaleUpMs: number): number {
  const shards = ceilDiv(pageCount, k);
  const tail = pageCount - (shards - 1) * k;
  const full = shardMs(profile, k);
  if (slots <= 1) return (shards - 1) * full + shardMs(profile, tail);
  // Greedy list schedule: each shard starts on the executor that frees first (late executors start at scaleUpMs).
  const free = Array.from({ length: slots }, (_, i) => (i < ready ? 0 : scaleUpMs));
  let end = 0;
  for (let i = 0; i < shards; i++) {
    let best = 0;
    for (let j = 1; j < free.length; j++) if (free[j]! < free[best]!) best = j;
    free[best] = free[best]! + (i === shards - 1 ? shardMs(profile, tail) : full);
    end = Math.max(end, free[best]!);
  }
  return end;
}

function costFor(profile: ShardCostProfile, pageCount: number, k: number): number {
  const shards = ceilDiv(pageCount, k);
  return ((shards * profile.fixedMs + pageCount * profile.perPageMs) / 1000) * profile.usdPerSecond;
}

/**
 * Chooses a shard size for one document. Returns a single shard (the whole document) when
 * splitting cannot beat it within the overhead budget, or when the document must be split
 * anyway (memory or timeout) the smallest compliant split.
 */
export function planPageShards(
  pageCount: number,
  profile: ShardCostProfile,
  capacity: ShardCapacity,
  options: PageShardOptions,
): PageShardPlan {
  const n = Math.max(1, Math.floor(pageCount));
  const align = Math.max(1, Math.floor(profile.pageAlign ?? 1));
  const ready = Math.max(1, Math.floor(capacity.readySlots));
  const maxSlots = Math.max(ready, Math.floor(capacity.maxSlots));
  const tolerance = Math.max(0, options.wallTolerance ?? 0.05);
  const unshardedWallMs = shardMs(profile, n);
  const unshardedCostUsd = costFor(profile, n, n);

  // Largest shard the executor can hold and finish in time.
  const byMemory = profile.perPageMiB > 0 ? Math.floor((profile.memoryLimitMiB - profile.baseMiB) / profile.perPageMiB) : Infinity;
  const byTime = profile.perPageMs > 0 ? Math.floor((profile.maxShardMs - profile.fixedMs) / profile.perPageMs) : Infinity;
  const hardMax = Math.max(1, Math.min(profile.maxShardPages, byMemory, byTime));
  const minPages = Math.max(1, Math.min(profile.minShardPages, hardMax));

  const candidates = new Set<number>();
  if (n <= hardMax) candidates.add(n);
  for (let k = Math.ceil(minPages / align) * align; k < n && k <= hardMax; k += align) candidates.add(k);
  // Even splits matched to executor counts, rounded up to the alignment.
  for (let s = 2; s <= Math.min(maxSlots, options.maxShards); s++) {
    const k = Math.ceil(ceilDiv(n, s) / align) * align;
    if (k >= minPages && k <= hardMax && k < n) candidates.add(k);
  }
  if (candidates.size === 0) candidates.add(Math.max(1, Math.floor(hardMax / align) * align || hardMax));

  type Option = { k: number; shards: number; wall: number; cost: number; parallel: number; scaleUp: boolean };
  const plans: Option[] = [];
  for (const k of candidates) {
    const shards = ceilDiv(n, k);
    if (shards > Math.max(1, options.maxShards) && k !== n) continue;
    const readyOnly = Math.min(shards, ready);
    const scaled = Math.min(shards, maxSlots);
    const wallReady = wallFor(profile, n, k, readyOnly, readyOnly, 0);
    const wallScaled = scaled > readyOnly ? wallFor(profile, n, k, scaled, readyOnly, capacity.scaleUpMs) : wallReady;
    const scaleUp = wallScaled < wallReady;
    const cost = costFor(profile, n, k);
    const overhead = unshardedCostUsd > 0 ? cost / unshardedCostUsd - 1 : 0;
    const forced = n > hardMax;
    if (k !== n && !forced && overhead > options.maxCostOverhead) continue;
    plans.push({ k, shards, wall: Math.min(wallReady, wallScaled), cost, parallel: scaleUp ? scaled : readyOnly, scaleUp });
  }
  if (plans.length === 0) {
    // Nothing affordable: the smallest split that still fits the executor.
    const k = Math.min(hardMax, n);
    plans.push({ k, shards: ceilDiv(n, k), wall: wallFor(profile, n, k, 1, 1, 0), cost: costFor(profile, n, k), parallel: 1, scaleUp: false });
  }

  const fastest = Math.min(...plans.map((o) => o.wall));
  const chosen = plans
    .filter((o) => o.wall <= fastest * (1 + tolerance))
    .sort((a, b) => a.shards - b.shards || a.cost - b.cost || b.k - a.k)[0]!;

  const reason = chosen.k >= n
    ? "unsharded: splitting does not pay for its fixed overhead"
    : n > hardMax && chosen.shards === ceilDiv(n, hardMax)
      ? `split for executor limits (max ${hardMax} pages per shard)`
      : `${chosen.shards} shards of ${chosen.k} pages on ${chosen.parallel} executors${chosen.scaleUp ? " (after scale-up)" : ""}`;
  return {
    shardPages: Math.min(chosen.k, n),
    shards: pageRanges(n, Math.min(chosen.k, n)),
    parallel: chosen.parallel,
    needsScaleUp: chosen.scaleUp,
    predictedWallMs: Math.round(chosen.wall),
    unshardedWallMs: Math.round(unshardedWallMs),
    predictedCostUsd: chosen.cost,
    unshardedCostUsd,
    reason,
  };
}

export interface ShardObservation {
  pages: number;
  ms: number;
  maxRssMiB?: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Theil–Sen line through (x, y): robust to the odd cold start or contended run. */
export function theilSen(points: Array<{ x: number; y: number }>): { slope: number; intercept: number } | null {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dx = points[j]!.x - points[i]!.x;
      if (dx !== 0) slopes.push((points[j]!.y - points[i]!.y) / dx);
    }
  }
  if (slopes.length === 0) return null;
  const slope = median(slopes);
  return { slope, intercept: median(points.map((p) => p.y - slope * p.x)) };
}

/**
 * Updates a profile from observed shard (or whole-document) timings on the same executor class.
 * The prior keeps weight `priorWeight` samples' worth, so a few noisy runs cannot swing the plan.
 */
export function calibrateShardProfile(
  prior: ShardCostProfile,
  observations: readonly ShardObservation[],
  priorWeight = 8,
): ShardCostProfile {
  const valid = observations.filter((o) => o.pages > 0 && Number.isFinite(o.ms) && o.ms >= 0);
  const distinct = new Set(valid.map((o) => o.pages)).size;
  if (valid.length < 3 || distinct < 2) return prior;
  const fit = theilSen(valid.map((o) => ({ x: o.pages, y: o.ms })));
  if (!fit || fit.slope <= 0) return prior;
  const w = valid.length / (valid.length + priorWeight);
  const blend = (a: number, b: number) => a * (1 - w) + b * w;
  const next: ShardCostProfile = {
    ...prior,
    fixedMs: Math.max(0, blend(prior.fixedMs, Math.max(0, fit.intercept))),
    perPageMs: blend(prior.perPageMs, fit.slope),
  };
  const mem = valid.filter((o) => typeof o.maxRssMiB === "number").map((o) => ({ x: o.pages, y: o.maxRssMiB! }));
  const memFit = new Set(mem.map((m) => m.x)).size >= 2 ? theilSen(mem) : null;
  if (memFit && memFit.slope >= 0) {
    // Memory errs high: never calibrate below what was observed.
    next.perPageMiB = Math.max(prior.perPageMiB, memFit.slope);
    next.baseMiB = Math.max(prior.baseMiB, memFit.intercept);
  }
  return next;
}
