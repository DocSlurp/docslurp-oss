import { describe, expect, it } from "vitest";

import { resolveVisionPageBudget } from "./vision-page-budget.js";

const pipeline = (parserPlaybook: string | undefined, maxPagesPerDocument = 4, forceAllPages = false) =>
  ({ parserPlaybook, vision: { maxPagesPerDocument, forceAllPages } }) as Parameters<typeof resolveVisionPageBudget>[0];

describe("resolveVisionPageBudget", () => {
  it("uses the run's playbook budget, balanced by default", () => {
    expect(resolveVisionPageBudget(pipeline(undefined))).toBe(4);
    expect(resolveVisionPageBudget(pipeline("review-grade"))).toBe(12);
    expect(resolveVisionPageBudget(pipeline("fast"))).toBe(0);
  });

  it("lets a classifier suggestion lower the budget or escalate it up to 12 pages", () => {
    // Raster pages make a document "degraded"; the suggested review-grade playbook lifts 4 to 12.
    expect(resolveVisionPageBudget(pipeline("balanced"), "review-grade")).toBe(12);
    expect(resolveVisionPageBudget(pipeline(undefined), "agentic")).toBe(Math.min(12, resolveVisionPageBudget(pipeline("agentic"))));
    // A workspace that allows no vision is never escalated.
    expect(resolveVisionPageBudget(pipeline("fast"), "review-grade")).toBe(0);
    expect(resolveVisionPageBudget(pipeline("review-grade"), "fast")).toBe(0);
    expect(resolveVisionPageBudget(pipeline("review-grade"), "review-grade")).toBe(12);
    expect(resolveVisionPageBudget(pipeline("balanced"), "not-a-playbook")).toBe(4);
  });

  it("forceAllPages uses the workspace page limit", () => {
    expect(resolveVisionPageBudget(pipeline("fast", 20, true), "review-grade")).toBe(20);
  });
});
