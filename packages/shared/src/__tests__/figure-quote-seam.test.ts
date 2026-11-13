import { describe, expect, it } from "vitest";

import { defaultPipelineFeatures } from "../pipeline.js";
import { openStoredBytes } from "../pricing-open.js";
import { estimateProfileFor, type QuoteFile } from "../upload-quote.js";

// The neutral figure-storage seam the estimator needs (core #357, no numbers in OSS): stored-work quotes carry measured
// figure bytes, and the profile says whether a run extracts figures (deploy flag and the project's opt-out).
describe("figure storage in quotes (core #357 on #355)", () => {
  const ON = { DOCSLURP_DOPPLER_IMAGE_EXTRACT: "1" };

  it("EstimateProfile.figures follows the deploy flag and the project's figures opt-out; a malformed flag is off", () => {
    expect(estimateProfileFor(defaultPipelineFeatures, { env: ON }).figures).toBe(true);
    expect(estimateProfileFor({ ...defaultPipelineFeatures, figures: false } as never, { env: ON }).figures).toBe(false);
    expect(estimateProfileFor(defaultPipelineFeatures, { env: {} }).figures).toBe(false);
    expect(estimateProfileFor(defaultPipelineFeatures, { env: { DOCSLURP_DOPPLER_IMAGE_EXTRACT: "maybe" } }).figures).toBe(false);
  });

  it("measured figure bytes (QuoteFile.measured.assetBytes) are hosted bytes in the open stored-bytes model", () => {
    const file = { name: "a.pdf", size: 1_000_000, type: "application/pdf", pages: 10 } as QuoteFile;
    const pages = { low: 10, high: 10 };
    const settings = { indexing: "on-demand" } as never;
    const base = openStoredBytes(file, pages, settings);
    const measured = openStoredBytes({ ...file, measured: { pages: 10, readPages: 10, assetBytes: 64 * 1024 * 1024 } }, pages, settings);
    expect(measured.low - base.low).toBe(64 * 1024 * 1024);
    expect(measured.high - base.high).toBe(64 * 1024 * 1024);
  });
});
