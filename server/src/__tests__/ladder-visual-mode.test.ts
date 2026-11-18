import { describe, expect, it } from "vitest";
import { defaultPipelineFeatures } from "@docslurp/shared";

import { assertVisualModeAllowed } from "../services/project-indexing-mode.js";
import { qualityAllowsVision } from "../services/ingest-report.js";

describe("visual indexing under the Auto ladder", () => {
  it("is allowed on Smartest only: refused on Fastest (any rung below intelligent) and with any share limit", () => {
    const base = { ...defaultPipelineFeatures, ladder: { maxRung: "intelligent" as const }, indexingMode: "visual" as const };
    expect(() => assertVisualModeAllowed(base)).not.toThrow();
    for (const ladder of [
      { maxRung: "fast" as const },
      { maxRung: "intelligent" as const, maxEscalationShare: { aboveFast: 0 } },
      { maxRung: "ocr" as const },
      { maxRung: "intelligent" as const, maxEscalationShare: { aboveFast: 0.5 } },
    ]) {
      expect(() => assertVisualModeAllowed({ ...base, ladder }), JSON.stringify(ladder)).toThrow(expect.objectContaining({ code: "visual_mode_quality" }));
    }
    // The default (Fastest) refuses it.
    expect(() => assertVisualModeAllowed({ ...defaultPipelineFeatures, indexingMode: "visual" })).toThrow(expect.objectContaining({ code: "visual_mode_quality" }));
  });

  it("the ingest report treats Auto capped at the fast rung as reading no page", () => {
    expect(qualityAllowsVision({ ...defaultPipelineFeatures, ladder: { maxRung: "fast" } })).toBe(false);
    expect(qualityAllowsVision({ ...defaultPipelineFeatures, ladder: { maxRung: "ocr" } })).toBe(true);
  });
});
