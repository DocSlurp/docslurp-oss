import { describe, expect, it } from "vitest";
import { defaultPipelineFeatures, normalizePipelineFeatures, pipelineFeaturesSchema, mergePipelineFeatures, applyWorkspacePipelineOverrides, getWorkspaceTemplate } from "../index.js";

describe("workspace video defaults", () => {
  it("enables missing schema/settings and canonical creation defaults", () => {
    expect(pipelineFeaturesSchema.parse({}).mediaVideo.enabled).toBe(true);
    expect(pipelineFeaturesSchema.parse({ mediaVideo: {} }).mediaVideo.enabled).toBe(true);
    expect(defaultPipelineFeatures.mediaVideo.enabled).toBe(true);
    expect(normalizePipelineFeatures({}).mediaVideo.enabled).toBe(true);
  });
  it("preserves explicit false and unrelated settings through all creation/override paths", () => {
    const source = { mediaVideo: { enabled: false, maxFrames: 17 }, maxCostCents: 12, summarize: true };
    const normalized = normalizePipelineFeatures(source);
    expect(normalized).toMatchObject(source);
    expect(mergePipelineFeatures(normalized, { pageIndex: true })).toMatchObject({ ...source, pageIndex: true });
    expect(applyWorkspacePipelineOverrides(normalized, { summarize: false }, getWorkspaceTemplate(null))).toMatchObject({ mediaVideo: { enabled: false, maxFrames: 17 }, maxCostCents: 12, summarize: false });
  });
});
