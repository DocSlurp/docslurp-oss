import { describe, expect, it } from "vitest";
import { withoutBilledRaises } from "./project-intake.js";

describe("a project created by an upload is never seeded with billed rungs (council #440 H1)", () => {
  it("drops quality good and the models chart tier, keeps everything else", () => {
    expect(withoutBilledRaises({ quality: "good", chartExport: { tier: "models", formats: ["csv"] }, figures: false, summarize: true }))
      .toEqual({ chartExport: { formats: ["csv"] }, figures: false, summarize: true });
    expect(withoutBilledRaises({ quality: "fast", chartExport: { tier: "free" } })).toEqual({ quality: "fast", chartExport: { tier: "free" } });
    expect(withoutBilledRaises(undefined)).toBeUndefined();
  });
});
