import { describe, expect, it } from "vitest";

import { visionAllowedForDocument } from "./vision-page-budget.js";

const pipeline = (quality: "fast" | "auto" | "good" | undefined) =>
  ({ quality }) as Parameters<typeof visionAllowedForDocument>[0];

describe("visionAllowedForDocument", () => {
  it("allows vision in auto (the default) and good, never in fast", () => {
    expect(visionAllowedForDocument(pipeline(undefined))).toBe(true);
    expect(visionAllowedForDocument(pipeline("auto"))).toBe(true);
    expect(visionAllowedForDocument(pipeline("good"))).toBe(true);
    expect(visionAllowedForDocument(pipeline("fast"))).toBe(false);
  });

  it("lets a classifier suggestion turn vision off in auto but never on in fast", () => {
    expect(visionAllowedForDocument(pipeline("auto"), "fast")).toBe(false);
    expect(visionAllowedForDocument(pipeline("fast"), "review-grade")).toBe(false);
    expect(visionAllowedForDocument(pipeline("auto"), "review-grade")).toBe(true);
    expect(visionAllowedForDocument(pipeline("auto"), "not-a-playbook")).toBe(true);
  });

  it("good reads every page whatever the suggestion", () => {
    expect(visionAllowedForDocument(pipeline("good"), "fast")).toBe(true);
  });
});
