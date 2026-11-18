import { describe, expect, it } from "vitest";

import { deprecatedPipelineFields } from "../lib/deprecation.js";

describe("Smartest keeps page images on and says so", () => {
  it("warns when a request asks for Smartest with page images off", () => {
    const warnings = deprecatedPipelineFields({ quality: "smartest", pageImages: false });
    expect(warnings).toEqual([expect.objectContaining({ code: "page_images_forced", field: "pipeline.pageImages" })]);
  });

  it("does not warn for Fastest with page images off or Smartest with them on", () => {
    expect(deprecatedPipelineFields({ quality: "fastest", pageImages: false })).toEqual([]);
    expect(deprecatedPipelineFields({ quality: "smartest", pageImages: true })).toEqual([]);
  });

  it("still warns, beside the deprecation, for the retired word", () => {
    const codes = deprecatedPipelineFields({ quality: "smart", pageImages: false }).map((warning) => warning.code);
    expect(codes).toEqual(expect.arrayContaining(["deprecated_field", "page_images_forced"]));
  });
});
