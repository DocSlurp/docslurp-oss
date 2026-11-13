// Deferred visuals: the guest result may carry them (validated), the candidate stats record them, and a later pass
// reads them back from a stage's stats with `deferredVisualsOf` (the hook the deferred pass builds on).
import { deferredVisualsOf, VISUAL_CANDIDATE_STATS_KEY, visualCandidateStatsSchema } from "@docslurp/shared";
import { describe, expect, it } from "vitest";

import { ChartExtractRefusedError, validateDeterministicResult } from "./extractors/host.js";
import { buildVisualCandidateStats } from "./stats.js";

const base = { schemaVersion: "chart-export-deterministic@v1", visuals: [], refusals: [] };
const entry = { input: "doppler-figure" as const, locator: "svg", reason: "svg-scene-budget", pageNumber: 3, figureId: "p3.g0" };

describe("deferred visuals", () => {
  it("accepts a guest result with deferred entries, and only well-formed ones", () => {
    expect(validateDeterministicResult({ ...base, deferred: [{ locator: "svg[4]", reason: "svg-scene-budget" }] }).deferred).toEqual([{ locator: "svg[4]", reason: "svg-scene-budget" }]);
    // Today's shape still validates.
    expect(validateDeterministicResult({ ...base })).toEqual(base);
    for (const bad of [
      { ...base, deferred: [] }, // sent only when non-empty
      { ...base, deferred: [{ locator: "svg", reason: "x", extra: 1 }] },
      { ...base, deferred: [{ locator: "x".repeat(513), reason: "x" }] },
      { ...base, deferred: Array.from({ length: 1001 }, () => ({ locator: "svg", reason: "x" })) },
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
    const stats = { [VISUAL_CANDIDATE_STATS_KEY]: buildVisualCandidateStats({ candidates: [], exported: [], deferred: [entry, { ...entry, input: "source", pageNumber: null, figureId: null, locator: "word/media/image2.svg" }] }) };
    // As persisted: a JSON round trip through the stage stats column.
    expect(deferredVisualsOf(JSON.parse(JSON.stringify(stats)))).toEqual([entry, { ...entry, input: "source", pageNumber: null, figureId: null, locator: "word/media/image2.svg" }]);
    expect(deferredVisualsOf(null)).toEqual([]);
    expect(deferredVisualsOf({})).toEqual([]);
    expect(deferredVisualsOf({ [VISUAL_CANDIDATE_STATS_KEY]: { deferred: [{ ...entry, input: "elsewhere" }, entry, "x"] } })).toEqual([entry]);
  });
});
