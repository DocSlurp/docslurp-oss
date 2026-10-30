import { describe, expect, it } from "vitest";

import { visionAllowedForDocument } from "./vision-page-budget.js";

const pipeline = (parserPlaybook: string | undefined, forceAllPages = false) =>
  ({ parserPlaybook, vision: { forceAllPages } }) as Parameters<typeof visionAllowedForDocument>[0];

describe("visionAllowedForDocument", () => {
  it("allows vision unless the run's playbook disallows it, balanced by default", () => {
    expect(visionAllowedForDocument(pipeline(undefined))).toBe(true);
    expect(visionAllowedForDocument(pipeline("review-grade"))).toBe(true);
    expect(visionAllowedForDocument(pipeline("fast"))).toBe(false);
  });

  it("lets a classifier suggestion turn vision off but never on", () => {
    expect(visionAllowedForDocument(pipeline("review-grade"), "fast")).toBe(false);
    expect(visionAllowedForDocument(pipeline("fast"), "review-grade")).toBe(false);
    expect(visionAllowedForDocument(pipeline("balanced"), "review-grade")).toBe(true);
    expect(visionAllowedForDocument(pipeline("balanced"), "not-a-playbook")).toBe(true);
  });

  it("forceAllPages always allows vision", () => {
    expect(visionAllowedForDocument(pipeline("fast", true), "fast")).toBe(true);
  });
});
