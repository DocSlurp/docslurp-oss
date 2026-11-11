import { describe, expect, it } from "vitest";
import { PIPELINE_FIELD_IMPACT, defaultPipelineFeatures, pipelineFeatureOverridesSchema, pipelineFeaturesSchema, resolveFirstPass, vmPdfExtractorOptionsSchema } from "../index.js";

describe("first-pass pipeline fields", () => {
  it("defaults to auto/auto and rejects unknown values", () => {
    expect(pipelineFeaturesSchema.parse({})).toMatchObject({ firstPass: "auto", afterFirstPass: "auto" });
    expect(pipelineFeatureOverridesSchema.safeParse({ firstPass: "bogus" }).success).toBe(false);
    expect(pipelineFeatureOverridesSchema.safeParse({ firstPass: "off" }).success).toBe(true);
  });

  it("refuses afterFirstPass none without the first pass, on that field", () => {
    const bad = pipelineFeatureOverridesSchema.safeParse({ afterFirstPass: "none", firstPass: "off" });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues[0]!.path).toEqual(["afterFirstPass"]);
  });

  it("the deploy flag always wins: on needs DOCSLURP_FIRST_PASS=on, off is always off", () => {
    expect(resolveFirstPass({ firstPass: "auto" }, { DOCSLURP_FIRST_PASS: "on" })).toBe(true);
    expect(resolveFirstPass({ firstPass: "on" }, {})).toBe(false);
    expect(resolveFirstPass({ firstPass: "off" }, { DOCSLURP_FIRST_PASS: "on" })).toBe(false);
    expect(resolveFirstPass({ firstPass: "auto" }, { DOCSLURP_FIRST_PASS: "1" })).toBe(false);
  });

  it("changing either field affects new uploads only", () => {
    expect(PIPELINE_FIELD_IMPACT.firstPass).toBe("new-uploads");
    expect(PIPELINE_FIELD_IMPACT.afterFirstPass).toBe("new-uploads");
    expect(defaultPipelineFeatures.firstPass).toBe("auto");
  });

  it("vm-pdf takes an opt-in math option", () => {
    expect(vmPdfExtractorOptionsSchema.parse({ math: true })).toEqual({ math: true });
    expect(vmPdfExtractorOptionsSchema.safeParse({ math: "yes" }).success).toBe(false);
  });
});
