// Unit reassembly for contained extraction: what a supervisor (the parser-VM guest's `chart-export-extract.mjs`, or the
// inline path) does after running an input's units across one or more workers, some of which crashed or overran.
// One copy of the resume charge and the output-budget re-check, so every supervisor enforces them the same way.
import { CHART_EXTRACT_LIMITS } from "./limits.js";
import { utf8Bytes } from "./spec-utils.js";
import type { UnitCharge, UnitDelta } from "./index.js";
import type { DeterministicDeferral, DeterministicVisual, DeterministicVisualResult } from "./types.js";

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
  for (const [id, d] of done) out.push([id, { visuals: d.delta.visuals.length, bytes: d.delta.bytes }]);
  for (const id of failedIds) out.push([id, { visuals: 0, bytes: 0 }]);
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
}

/**
 * One input's result from its units: the last worker's own result unchanged when nothing failed (identical to an
 * uncontained run); otherwise the units earlier workers finished, the failed units counted, and the last worker's own
 * accounting, with visuals re-checked against the visual cap and `outputBudget` (excess counted, never thrown).
 */
export function reassembleUnits(input: ReassembleInput): DeterministicVisualResult {
  const { done, final, lastWorker, unplaced, outputBudget } = input;
  const failed = [...input.failed];
  if (final && failed.length === 0 && !unplaced) return final;
  const earlier = [...done].filter(([, d]) => !final || d.worker !== lastWorker).sort((a, b) => a[0] - b[0]).map(([, d]) => d.delta);
  const lost: DeterministicDeferral[] = [...failed].sort((a, b) => a.id - b.id).map((f) => ({ svgIndex: f.svgIndex, count: 1, reason: f.reason }));
  const base: DeterministicVisualResult = final ?? { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [], overflow: 0 };
  const visuals: DeterministicVisual[] = [];
  const deferredExtra: DeterministicDeferral[] = [];
  let bytes = 0;
  for (const v of [...earlier.flatMap((d) => d.visuals), ...base.visuals]) {
    const size = visualBytes(v);
    if (visuals.length >= CHART_EXTRACT_LIMITS.maxVisuals || bytes + size > outputBudget) {
      deferredExtra.push({ svgIndex: 0, count: 1, reason: visuals.length >= CHART_EXTRACT_LIMITS.maxVisuals ? "visual-limit" : "output-limit" });
      continue;
    }
    bytes += size;
    visuals.push(v);
  }
  const refusals = [...earlier.flatMap((d) => d.refusals), ...base.refusals, ...(unplaced ? [{ locator: unplaced.locator, reason: "unit-crashed" }] : [])];
  const deferred = mergeDeferred([
    ...earlier.flatMap((d) => d.deferred), ...lost,
    ...(unplaced ? [{ svgIndex: unplaced.svgIndex, count: 1, reason: "unit-crashed" as const }] : []),
    ...(base.deferred ?? []), ...deferredExtra,
  ]);
  const overflow = earlier.reduce((n, d) => n + d.overflow, 0) + (base.overflow ?? 0) + Math.max(0, refusals.length - 1000);
  return {
    schemaVersion: "chart-export-deterministic@v1",
    visuals,
    refusals: refusals.slice(0, 1000),
    ...(overflow > 0 ? { overflow } : {}),
    ...(deferred.length ? { deferred } : {}),
  };
}
