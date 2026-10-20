import { describe, expect, it } from "vitest";

import { deriveSelfQueryFilters } from "../search/self-query.js";

describe("deriveSelfQueryFilters", () => {
  it("extracts page range, document hint, and mime filters from explicit queries", async () => {
    const plan = await deriveSelfQueryFilters({
      query: 'In the "Q4 board deck", what changed on slide 12?',
      baseFilters: { workspaceId: "ws-1" },
      privacyMode: "standard",
      usage: { record: () => undefined },
    });

    expect(plan.filters.workspaceId).toBe("ws-1");
    expect(plan.filters.filenameContains).toBe("Q4 board deck");
    expect(plan.filters.pageRange).toEqual({ from: 12, to: 12 });
    expect(plan.filters.mimeTypes).toContain("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(plan.reasons.length).toBeGreaterThan(0);
  });
});


it("plans explicit tags without widening caller restrictions or inventing filename filters", async () => {
  const base = { privacyMode: "standard" as const, usage: { record: () => undefined } };
  const plan = await deriveSelfQueryFilters({ ...base, query: 'find budgets tag:"finance team" tag:FY26' });
  expect(plan.filters.tags).toEqual(["finance team", "FY26"]);
  expect(plan.filters.filenameContains).toBeUndefined();
  const restricted = await deriveSelfQueryFilters({ ...base, query: "find budgets tag:other", baseFilters: { tags: ["finance"] } });
  expect(restricted.filters.tags).toEqual(["finance"]);
});
