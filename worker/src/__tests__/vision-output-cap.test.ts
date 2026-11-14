import { describe, expect, it } from "vitest";

import { visionRequestProfileFor, type VisionRequestProfile } from "@docslurp/shared";

import { visionMaxOutputTokens, visionOutputCap } from "../tools/vision-runtime.js";

const MODEL = "z-ai/glm-5.3-flash";
const SERVER = visionRequestProfileFor("lightonai/LightOnOCR-3-0.8B")!; // maxOutputTokens "server", contextTokens 18000
const NUMERIC: VisionRequestProfile = { maxOutputTokens: 4_096 };

describe("visionOutputCap: one cap for admission and the request", () => {
  it("unprofiled: the model cap, lowered by a call cap and never raised", () => {
    const modelCap = visionMaxOutputTokens(MODEL);
    expect(visionOutputCap(MODEL)).toEqual({ maxTokens: modelCap, bound: modelCap });
    expect(visionOutputCap(MODEL, undefined, 100)).toEqual({ maxTokens: 100, bound: 100 });
    expect(visionOutputCap(MODEL, undefined, 10 ** 6)).toEqual({ maxTokens: modelCap, bound: modelCap });
  });

  it("a numeric profile replaces the model cap; a call cap lowers it", () => {
    expect(visionOutputCap(MODEL, NUMERIC)).toEqual({ maxTokens: 4_096, bound: 4_096 });
    expect(visionOutputCap(MODEL, NUMERIC, 512)).toEqual({ maxTokens: 512, bound: 512 });
    expect(visionOutputCap(MODEL, NUMERIC, 8_192)).toEqual({ maxTokens: 4_096, bound: 4_096 });
  });

  it('"server" sends none and bounds by contextTokens; a call cap is sent and lowers it', () => {
    expect(visionOutputCap(MODEL, SERVER)).toEqual({ maxTokens: null, bound: 18_000 });
    expect(visionOutputCap(MODEL, SERVER, 512)).toEqual({ maxTokens: 512, bound: 512 });
    expect(visionOutputCap(MODEL, SERVER, 50_000)).toEqual({ maxTokens: 18_000, bound: 18_000 });
  });

  it("ignores an invalid call cap the same way for every profile (never sends contextTokens for \"server\")", () => {
    for (const profile of [undefined, NUMERIC, SERVER]) {
      for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(visionOutputCap(MODEL, profile, bad)).toEqual(visionOutputCap(MODEL, profile));
      }
    }
  });

  it("admits exactly what it sends whenever it sends a cap", () => {
    for (const profile of [undefined, NUMERIC, SERVER]) {
      for (const call of [undefined, 1, 512, 4_096, 50_000]) {
        const cap = visionOutputCap(MODEL, profile, call);
        if (cap.maxTokens !== null) expect(cap.bound).toBe(cap.maxTokens);
      }
    }
  });
});
