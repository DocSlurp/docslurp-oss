// Deferred visuals: the guest result may carry them (validated), the candidate stats record them, and a later pass
// reads them back from a stage's stats with `deferredVisualsOf` (the hook the deferred pass builds on).
import { deferredVisualsOf, VISUAL_CANDIDATE_STATS_KEY, visualCandidateStatsSchema } from "@docslurp/shared";
import { describe, expect, it } from "vitest";

import { ChartExtractRefusedError, validateDeterministicResult } from "./extractors/host.js";
import { buildVisualCandidateStats } from "./stats.js";

const base = { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [] };
const entry = { input: "doppler-figure" as const, svgIndex: 0, reason: "svg-document-limit" as const, pageNumber: 3, figureId: "p3.g0" };

describe("deferred visuals", () => {
  it("accepts a guest result with deferred entries, and only well-formed ones", () => {
    expect(validateDeterministicResult({ ...base, deferred: [{ svgIndex: 400, reason: "svg-document-limit" }] }).deferred).toEqual([{ svgIndex: 400, reason: "svg-document-limit" }]);
    // Today's shape still validates.
    expect(validateDeterministicResult({ ...base })).toEqual(base);
    for (const bad of [
      { ...base, deferred: [] }, // sent only when non-empty
      { ...base, deferred: [{ svgIndex: 1, reason: "svg-document-limit", extra: 1 }] },
      // Closed reasons and an ordinal only: no guest strings (council r4 L1).
      { ...base, deferred: [{ svgIndex: 1, reason: "svg-scene-budget" }] },
      { ...base, deferred: [{ svgIndex: 1, reason: "<img src=x>" }] },
      { ...base, deferred: [{ locator: "word/media/customer-name.svg", reason: "svg-document-limit" }] },
      { ...base, deferred: [{ svgIndex: -1, reason: "svg-document-limit" }] },
      { ...base, deferred: [{ svgIndex: 1.5, reason: "svg-document-limit" }] },
      { ...base, deferred: Array.from({ length: 1001 }, (_, i) => ({ svgIndex: i, reason: "svg-document-limit" })) },
      { ...base, deferred: "svg" },
      { ...base, other: [] },
    ]) expect(() => validateDeterministicResult(bad)).toThrow(ChartExtractRefusedError);
  });

  it("records them in the candidate stats only when there are some", () => {
    const none = buildVisualCandidateStats({ candidates: [], exported: [] });
    expect("deferred" in none).toBe(false);
    const some = buildVisualCandidateStats({ candidates: [], exported: [], deferred: [entry] });
    expect(some.deferred).toEqual([entry]);
    expect(visualCandidateStatsSchema.parse(some)).toEqual(some);
  });

  it("reads them back from a stage's stats for the deferred pass, ignoring anything malformed", () => {
    const stats = { [VISUAL_CANDIDATE_STATS_KEY]: buildVisualCandidateStats({ candidates: [], exported: [], deferred: [entry, { ...entry, input: "source" as const, pageNumber: null, figureId: null, svgIndex: 412 }] }) };
    // As persisted: a JSON round trip through the stage stats column.
    expect(deferredVisualsOf(JSON.parse(JSON.stringify(stats)))).toEqual([entry, { ...entry, input: "source" as const, pageNumber: null, figureId: null, svgIndex: 412 }]);
    expect(deferredVisualsOf(null)).toEqual([]);
    expect(deferredVisualsOf({})).toEqual([]);
    expect(deferredVisualsOf({ [VISUAL_CANDIDATE_STATS_KEY]: { deferred: [{ ...entry, input: "elsewhere" }, { ...entry, reason: "free text" }, { ...entry, locator: "x" }, entry, "x"] } })).toEqual([entry]);
  });
});
