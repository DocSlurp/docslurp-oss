import { describe, expect, it } from "vitest";

import { costEstimateSchema, jobStatusSchema } from "../jobs.js";

describe("job contracts", () => {
  const estimate = { pages: 10, documents: 1, credits: { low: 1, high: 2 }, seconds: { low: 5, high: 9 }, basis: "profile", billing: "enforced" as const };
  it("parses an estimate with credits and without (billing disabled)", () => {
    expect(costEstimateSchema.parse(estimate)).toEqual(estimate);
    expect(costEstimateSchema.parse({ ...estimate, credits: null, billing: "disabled" }).credits).toBeNull();
    expect(costEstimateSchema.parse({ ...estimate, seconds: null }).seconds).toBeNull();
  });
  it("requires billing and ties it to credits", () => {
    const { billing: _b, ...noBilling } = estimate;
    expect(() => costEstimateSchema.parse(noBilling)).toThrow();
    expect(() => costEstimateSchema.parse({ ...estimate, billing: "disabled" })).toThrow();
    expect(() => costEstimateSchema.parse({ ...estimate, credits: null })).toThrow();
  });
  it("parses blocked jobs with a reason", () => {
    const job = jobStatusSchema.parse({
      id: "r1", kind: "reindex", status: "blocked", reason: "credits",
      queue: { position: null, ahead: null }, runIds: ["r1"], estimate: null, estimateUrl: "/v1/x", statusUrl: "/v1/jobs/r1",
    });
    expect(job.reason).toBe("credits");
    expect(() => jobStatusSchema.parse({ ...job, status: "nope" })).toThrow();
  });
});
