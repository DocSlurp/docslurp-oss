import { describe, expect, it, vi } from "vitest";
import { normalizePipelineFeatures } from "@docslurp/shared";

vi.mock("../db.js", () => ({ sql: Object.assign(vi.fn(), { unsafe: vi.fn(), begin: vi.fn() }) }));
const { stampRunConfigV1 } = await import("../services/run-creation.js");

/** Release R1: new runs stamp the new shape only once the whole fleet advertises extraction.config-v1. */
describe("stampRunConfigV1", () => {
  const run = normalizePipelineFeatures({ quality: "good", chartExport: { tier: "free" } } as never);

  it("keeps the legacy shape while the fleet does not advertise v1 (unknown, mixed or older workers)", () => {
    expect(stampRunConfigV1(run, {}, () => false)).toBe(run);
  });

  it("stamps configVersion 1 once it does, and the opt-out keeps the legacy shape", () => {
    expect(stampRunConfigV1(run, {}, () => true)).toMatchObject({ configVersion: 1, quality: "smart", visuals: "charts" });
    expect(stampRunConfigV1(run, { DOCSLURP_EXTRACTION_CONFIG_V1_STAMP: "off" }, () => true)).toBe(run);
  });

  it("never stamps a run whose new shape would widen it", () => {
    const narrow = normalizePipelineFeatures({ quality: "auto", visionFallback: false, chartExport: { tier: "off" } } as never);
    expect(stampRunConfigV1(narrow, {}, () => true)).toBe(narrow);
  });
});
