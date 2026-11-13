// Unit reassembly for contained extraction: what a supervisor (the parser-VM guest's `chart-export-extract.mjs`, or the
// inline path) does after running an input's units across one or more workers, some of which crashed or overran.
// One copy of the resume charge and the output-budget re-check, so every supervisor enforces them the same way.
import { CHART_EXTRACT_LIMITS } from "./limits.js";
import { capRefusal, capVisual } from "./result-caps.js";
import { utf8Bytes } from "./spec-utils.js";
import type { UnitCharge, UnitDelta } from "./index.js";
import type { DeterministicDeferral, DeterministicRefusal, DeterministicVisual, DeterministicVisualResult } from "./types.js";

/** A unit a worker finished: its output, and which worker finished it. */
export interface FinishedUnit { delta: UnitDelta; worker: number }
/** A unit whose worker crashed or overran while running it. */
export interface FailedUnit { id: number; svgIndex: number; reason: "unit-crashed" | "unit-timeout" }

/** Serialized bytes of one visual, as the extractor charges it to the output budget. */
export function visualBytes(v: DeterministicVisual): number {
  return utf8Bytes(JSON.stringify(v));
}

/** Serialized bytes of a result's visuals (what a batch charges against its shared budget). */
export function resultVisualBytes(r: Pick<DeterministicVisualResult, "visuals">): number {
  let n = 0;
  for (const v of r.visuals) n += visualBytes(v);
  return n;
}

/**
 * The skip list for the next worker (`UnitControl.skip` entries): every finished unit charged with what it produced,
 * so the visual cap and output budget resume where they were, and every failed unit charged nothing.
 */
export function resumeSkipList(done: ReadonlyMap<number, FinishedUnit>, failedIds: Iterable<number>): Array<[number, UnitCharge]> {
  const out: Array<[number, UnitCharge]> = [];
  for (const [id, d] of done) out.push([id, { visuals: d.delta.visuals.length, bytes: d.delta.bytes, full: d.delta.full ?? null }]);
  for (const id of failedIds) out.push([id, { visuals: 0, bytes: 0, full: null }]);
  return out;
}

/** Reasons the extractor keeps as one entry per input; merged again after a resume (council r9 I2). */
const MERGED_REASONS = new Set<DeterministicDeferral["reason"]>(["visual-limit", "output-limit", "package-part-limit", "guest-deadline-part"]);

/** Merge same-reason per-input entries (lowest ordinal, summed count); other entries kept in order; at most 1,000. */
export function mergeDeferred(list: readonly DeterministicDeferral[]): DeterministicDeferral[] {
  const out: DeterministicDeferral[] = [];
  for (const d of list) {
    const same = MERGED_REASONS.has(d.reason) ? out.find((e) => e.reason === d.reason) : undefined;
    if (same) { same.svgIndex = Math.min(same.svgIndex, d.svgIndex); same.count += d.count; } else out.push({ ...d });
  }
  return out.slice(0, 1000);
}

export interface ReassembleInput {
  /** Units finished by any worker, by unit id. */
  done: ReadonlyMap<number, FinishedUnit>;
  /** Units lost to a crash or overrun. */
  failed: Iterable<FailedUnit>;
  /** The last worker's own result, when it returned one. */
  final: DeterministicVisualResult | null;
  /** Index of the last worker (its finished units are already in `final`). */
  lastWorker: number;
  /**
   * A failure outside any unit, or in the counting worker: counted from `svgIndex` as one deferred unit (a lower bound)
   * and refused under `locator` (the input kind).
   */
  unplaced: { svgIndex: number; locator: string } | null;
  /** The input's output budget in bytes, re-checked while merging. */
  outputBudget: number;
  /** The whole result's size budget in bytes (default `MAX_RESULT_BYTES`); see `fitResult`. */
  maxResultBytes?: number;
}

/** The most one result (or one batch of results) may serialize to: the host's cap on a guest result file. */
export const MAX_RESULT_BYTES = 16 * 1024 * 1024;

/**
 * Hold a result to `maxBytes` serialized, never by throwing (council r10 M1): past it, refusals are dropped from the end
 * and counted in `overflow`, then visuals from the end and counted as `output-limit`. Returned unchanged when it fits.
 * The budgets upstream keep every ordinary result far under the cap; this is the last line, so it is simple and exact.
 */
export function fitResult(r: DeterministicVisualResult, maxBytes: number = MAX_RESULT_BYTES): DeterministicVisualResult {
  let size = utf8Bytes(JSON.stringify(r));
  if (size <= maxBytes) return r;
  // Room for the counts this adds (an overflow number and one deferral entry).
  const target = Math.max(0, maxBytes - 4096);
  const refusals = [...r.refusals];
  const visuals = [...r.visuals];
  let dropped = 0;
  let cut = 0;
  while (size > target && refusals.length) { size -= utf8Bytes(JSON.stringify(refusals.pop())) + 1; dropped++; }
  while (size > target && visuals.length) { size -= visualBytes(visuals.pop()!) + 1; cut++; }
  const before = r.deferred ?? [];
  const deferred = mergeDeferred([...before, ...(cut ? [{ svgIndex: 0, count: cut, reason: "output-limit" as const }] : [])]);
  // A full deferral list (1,000 entries) can leave no room for the cut's entry: whatever count the list could not keep
  // is added to `overflow`, so every cut stays counted (council r11 L2).
  const unlisted = sumCounts(before) + cut - sumCounts(deferred);
  const overflow = (r.overflow ?? 0) + dropped + unlisted;
  const out: DeterministicVisualResult = { schemaVersion: r.schemaVersion, visuals, refusals, ...(overflow > 0 ? { overflow } : {}), ...(deferred.length ? { deferred } : {}) };
  if (utf8Bytes(JSON.stringify(out)) <= maxBytes) return out;
  // Only deferral entries are left (at most 1,000 small ones) and even they do not fit (a budget far below any the
  // guest uses): keep the counts alone, one entry per reason, and never a zero count (council r11 L1).
  const byReason = new Map<DeterministicDeferral["reason"], DeterministicDeferral>();
  for (const d of [...before, ...(r.visuals.length ? [{ svgIndex: 0, count: r.visuals.length, reason: "output-limit" as const }] : [])]) {
    const e = byReason.get(d.reason);
    if (e) { e.svgIndex = Math.min(e.svgIndex, d.svgIndex); e.count += d.count; } else byReason.set(d.reason, { ...d });
  }
  const counts = [...byReason.values()].filter((d) => d.count > 0);
  const lastOverflow = (r.overflow ?? 0) + r.refusals.length;
  return { schemaVersion: r.schemaVersion, visuals: [], refusals: [], ...(lastOverflow > 0 ? { overflow: lastOverflow } : {}), ...(counts.length ? { deferred: counts } : {}) };
}

const sumCounts = (list: readonly DeterministicDeferral[]) => list.reduce((n, d) => n + d.count, 0);

/**
 * One input's result from its units: the last worker's own result unchanged when nothing failed (identical to an
 * uncontained run); otherwise the units earlier workers finished, the failed units counted, and the last worker's own
 * accounting, with visuals re-checked against the visual cap and `outputBudget` (excess counted, never thrown).
 */
export function reassembleUnits(input: ReassembleInput): DeterministicVisualResult {
  const { done, final, lastWorker, unplaced, outputBudget } = input;
  const failed = [...input.failed];
  if (final && failed.length === 0 && !unplaced) return fitResult(final, input.maxResultBytes);
  const earlier = [...done].filter(([, d]) => !final || d.worker !== lastWorker).sort((a, b) => a[0] - b[0]).map(([, d]) => d.delta);
  const lost: DeterministicDeferral[] = [...failed].sort((a, b) => a.id - b.id).map((f) => ({ svgIndex: f.svgIndex, count: 1, reason: f.reason }));
  const base: DeterministicVisualResult = final ?? { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [], overflow: 0 };
  const visuals: DeterministicVisual[] = [];
  const deferredExtra: DeterministicDeferral[] = [];
  let bytes = 0;
  // Every field capped exactly as the normal path caps it (idempotent for deltas already capped by the extractor).
  for (const v of [...earlier.flatMap((d) => d.visuals), ...base.visuals].map(capVisual)) {
    const size = visualBytes(v);
    if (visuals.length >= CHART_EXTRACT_LIMITS.maxVisuals || bytes + size > outputBudget) {
      deferredExtra.push({ svgIndex: 0, count: 1, reason: visuals.length >= CHART_EXTRACT_LIMITS.maxVisuals ? "visual-limit" : "output-limit" });
      continue;
    }
    bytes += size;
    visuals.push(v);
  }
  const refusals: DeterministicRefusal[] = [...earlier.flatMap((d) => d.refusals), ...base.refusals, ...(unplaced ? [{ locator: unplaced.locator, reason: "unit-crashed" }] : [])].map(capRefusal);
  const deferred = mergeDeferred([
    ...earlier.flatMap((d) => d.deferred), ...lost,
    ...(unplaced ? [{ svgIndex: unplaced.svgIndex, count: 1, reason: "unit-crashed" as const }] : []),
    ...(base.deferred ?? []), ...deferredExtra,
  ]);
  const overflow = earlier.reduce((n, d) => n + d.overflow, 0) + (base.overflow ?? 0) + Math.max(0, refusals.length - 1000);
  return fitResult({
    schemaVersion: "chart-export-deterministic@v1",
    visuals,
    refusals: refusals.slice(0, 1000),
    ...(overflow > 0 ? { overflow } : {}),
    ...(deferred.length ? { deferred } : {}),
  }, input.maxResultBytes);
}
