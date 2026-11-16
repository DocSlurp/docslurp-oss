import { describe, expect, it } from "vitest";
import { normalizePipelineFeatures, runConfigSemantics, runPipelineToConfigV1 } from "../index.js";

/** Release R1 run stamp: the new shape is used only when the worker's read of it is exactly the legacy run. */
describe("runPipelineToConfigV1", () => {
  const legacy = (over: Record<string, unknown>) => normalizePipelineFeatures(over as never) as unknown as Record<string, unknown>;
  const cases: Array<[string, Record<string, unknown>]> = [
    ["fast", { quality: "fast", chartExport: { tier: "off" } }],
    ["auto with rescue", { quality: "auto", visionFallback: true, chartExport: { tier: "free" } }],
    ["good", { quality: "good", chartExport: { tier: "models" } }],
    ["figures off, tier off", { quality: "auto", figures: false, chartExport: { tier: "off" } }],
  ];

  it("round-trips: the worker's read of the stamp is the same run", () => {
    for (const [name, over] of cases) {
      const run = legacy(over);
      const stamped = runPipelineToConfigV1(run);
      expect(stamped, name).not.toBeNull();
      expect(runConfigSemantics(stamped), name).toBe(1);
      const back = normalizePipelineFeatures(stamped as never);
      expect(back.quality, name).toBe(run.quality);
      expect(back.figures, name).toBe(run.figures);
      expect(back.chartExport?.tier, name).toBe((run.chartExport as { tier?: string }).tier);
      if (run.quality === "auto") expect(back.visionFallback, name).toBe(run.visionFallback);
    }
  });

  it("keeps the legacy shape when the new one would widen the run", () => {
    expect(runPipelineToConfigV1(legacy({ quality: "auto", visionFallback: false, chartExport: { tier: "off" } }))).toBeNull();
    expect(runPipelineToConfigV1(legacy({ quality: "auto", figures: false, chartExport: { tier: "models" } }))).toBeNull();
    expect(runPipelineToConfigV1({ quality: "auto" })).toBeNull(); // no resolved tier
    expect(runPipelineToConfigV1({ quality: "balanced", configVersion: 1 })).toBeNull(); // already stamped
  });
});
