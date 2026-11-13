// reassemble.ts is the one copy of contained-extraction reassembly (the guest's parent and the inline supervisor both
// call it). It replaced code inline in scripts/chart-export-extract.mjs; this compares it with that code on seeded
// random scenarios, so behaviour stays identical.
import { describe, expect, it } from "vitest";

import { CHART_EXTRACT_LIMITS } from "../limits.js";
import { mergeDeferred, reassembleUnits, resultVisualBytes, resumeSkipList, visualBytes, type FailedUnit, type FinishedUnit } from "../reassemble.js";
import { emptyVisual, type DeterministicDeferral, type DeterministicVisualResult } from "../types.js";
import type { UnitDelta } from "../index.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// The code reassemble.ts replaced (scripts/chart-export-extract.mjs at 93c080686), verbatim apart from parameters.
const OLD_MERGED = new Set(["visual-limit", "output-limit", "package-part-limit", "guest-deadline-part"]);
const oldVisualBytes = (v: any) => Buffer.byteLength(JSON.stringify(v));
function oldMergeDeferred(list: any[]) {
  const out: any[] = [];
  for (const d of list) {
    const same = OLD_MERGED.has(d.reason) ? out.find((e) => e.reason === d.reason) : null;
    if (same) { same.svgIndex = Math.min(same.svgIndex, d.svgIndex); same.count += d.count; } else out.push({ ...d });
  }
  return out.slice(0, 1000);
}
function oldReassemble(done: Map<number, any>, failed: Map<number, any>, final: any, lastWorker: number, unplaced: boolean, nextSvg: number, kind: string, outputBudget: number) {
  if (final && failed.size === 0) return final;
  const earlier = [...done].filter(([, d]) => !final || d.worker !== lastWorker).sort((a, b) => a[0] - b[0]).map(([, d]) => d.delta);
  const lost = [...failed.values()].sort((a, b) => a.id - b.id).map((f) => ({ svgIndex: f.svgIndex, count: 1, reason: f.reason }));
  const base = final ?? { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [], overflow: 0 };
  const visuals: any[] = [];
  const deferredExtra: any[] = [];
  let bytes = 0;
  for (const v of [...earlier.flatMap((d: any) => d.visuals), ...base.visuals]) {
    const size = oldVisualBytes(v);
    if (visuals.length >= CHART_EXTRACT_LIMITS.maxVisuals || bytes + size > outputBudget) { deferredExtra.push({ svgIndex: 0, count: 1, reason: visuals.length >= CHART_EXTRACT_LIMITS.maxVisuals ? "visual-limit" : "output-limit" }); continue; }
    bytes += size;
    visuals.push(v);
  }
  const refusals = [...earlier.flatMap((d: any) => d.refusals), ...base.refusals, ...(unplaced ? [{ locator: kind, reason: "unit-crashed" }] : [])];
  const deferred = oldMergeDeferred([...earlier.flatMap((d: any) => d.deferred), ...lost, ...(unplaced ? [{ svgIndex: nextSvg, count: 1, reason: "unit-crashed" }] : []), ...(base.deferred ?? []), ...deferredExtra]);
  const overflow = earlier.reduce((n: number, d: any) => n + d.overflow, 0) + (base.overflow ?? 0) + Math.max(0, refusals.length - 1000);
  return { schemaVersion: "chart-export-deterministic@v1", visuals, refusals: refusals.slice(0, 1000), ...(overflow > 0 ? { overflow } : {}), ...(deferred.length ? { deferred } : {}) };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const REASONS: DeterministicDeferral["reason"][] = ["svg-document-limit", "html-svg-limit", "guest-deadline", "visual-limit", "package-part-limit", "guest-deadline-part", "unit-crashed", "unit-timeout", "output-limit"];

describe("reassembleUnits", () => {
  it("matches the guest's former inline reassembly on 2,000 seeded scenarios", () => {
    const random = rng(369);
    const int = (n: number) => Math.floor(random() * n);
    const visual = (k: number) => {
      const v = emptyVisual("svg-geometry", `svg[${k}]`);
      v.reason = random() < 0.2 ? "图".repeat(int(60)) + "😀" : null;
      v.digest = "x".repeat(int(4000));
      return v;
    };
    const deferral = (): DeterministicDeferral => ({ svgIndex: int(500), count: 1 + int(5), reason: REASONS[int(REASONS.length)]! });
    const delta = (): UnitDelta => {
      const visuals = Array.from({ length: int(random() < 0.05 ? 300 : 4) }, (_, k) => visual(k));
      return { visuals, refusals: Array.from({ length: int(random() < 0.05 ? 1200 : 3) }, (_, k) => ({ locator: `p${k}`, reason: "svg-too-dense" })), deferred: Array.from({ length: int(3) }, deferral), overflow: int(3), bytes: visuals.reduce((n, v) => n + visualBytes(v), 0) };
    };
    let differing = 0;
    for (let s = 0; s < 2000; s++) {
      const workers = 1 + int(4);
      const done = new Map<number, FinishedUnit>();
      const failed = new Map<number, FailedUnit>();
      for (let id = 0; id < int(40); id++) {
        if (random() < 0.1) failed.set(id, { id, svgIndex: int(100), reason: random() < 0.5 ? "unit-crashed" : "unit-timeout" });
        else done.set(id, { delta: delta(), worker: int(workers) });
      }
      const unplaced = random() < 0.15;
      const final: DeterministicVisualResult | null = unplaced ? null : {
        schemaVersion: "chart-export-deterministic@v1",
        visuals: Array.from({ length: int(10) }, (_, k) => visual(k)),
        refusals: [{ locator: "x", reason: "svg-use-bomb" }],
        ...(random() < 0.5 ? { overflow: int(4) } : {}),
        ...(random() < 0.5 ? { deferred: Array.from({ length: 1 + int(3) }, deferral) } : {}),
      };
      const nextSvg = int(200);
      const budget = [0, 2000, 50_000, CHART_EXTRACT_LIMITS.maxOutputBytes][int(4)]!;
      // Fresh copies per side: mergeDeferred must not mutate its inputs in either.
      const copy = <T>(x: T): T => structuredClone(x);
      const want = oldReassemble(copy(done), copy(failed), copy(final), workers - 1, unplaced, nextSvg, "html", budget);
      const got = reassembleUnits({ done: copy(done), failed: copy(failed).values(), final: copy(final), lastWorker: workers - 1, unplaced: unplaced ? { svgIndex: nextSvg, locator: "html" } : null, outputBudget: budget });
      if (JSON.stringify(got) !== JSON.stringify(want)) differing++;
    }
    expect(differing).toBe(0);
  });

  it("returns the last worker's result unchanged when nothing failed", () => {
    const final: DeterministicVisualResult = { schemaVersion: "chart-export-deterministic@v1", visuals: [emptyVisual("svg-geometry", "svg[0]")], refusals: [] };
    expect(reassembleUnits({ done: new Map(), failed: [], final, lastWorker: 0, unplaced: null, outputBudget: 0 })).toBe(final);
  });

  it("charges finished units and failed units in the resume skip list", () => {
    const v = emptyVisual("svg-geometry", "svg[0]");
    const done = new Map<number, FinishedUnit>([[3, { worker: 0, delta: { visuals: [v], refusals: [], deferred: [], overflow: 0, bytes: visualBytes(v) } }]]);
    expect(resumeSkipList(done, [5])).toEqual([[3, { visuals: 1, bytes: visualBytes(v) }], [5, { visuals: 0, bytes: 0 }]]);
  });

  it("merges per-input reasons and counts bytes as the extractor does", () => {
    expect(mergeDeferred([{ svgIndex: 4, count: 1, reason: "output-limit" }, { svgIndex: 2, count: 3, reason: "unit-crashed" }, { svgIndex: 0, count: 2, reason: "output-limit" }]))
      .toEqual([{ svgIndex: 0, count: 3, reason: "output-limit" }, { svgIndex: 2, count: 3, reason: "unit-crashed" }]);
    const v = emptyVisual("svg-geometry", "图😀");
    expect(visualBytes(v)).toBe(Buffer.byteLength(JSON.stringify(v)));
    expect(resultVisualBytes({ visuals: [v, v] })).toBe(2 * visualBytes(v));
  });
});
