import { expect, it } from "vitest";
import type { SearchFilters } from "../search/filters.js";
import { qualifyCommunitySummary } from "../search/community-context.js";

it("retains community summaries and qualifies broader evidence in tagged context", () => {
  const summary = "Revenue increased across departments.";
  expect(qualifyCommunitySummary(summary)).toBe(summary);
  const qualified = qualifyCommunitySummary(summary, { tags: ["finance"] });
  expect(qualified).toContain('selected document scope {"tags":["finance"]}');
  expect(qualified).toContain("may include documents outside that selection");
  expect(qualified.endsWith(summary)).toBe(true);
});

it.each<SearchFilters>([{ documentId: "selected" }, { mimeTypes: ["text/plain"] }, { pageRange: { from: 2 } }, { runId: "r" }])("qualifies broad context for scope %j and preserves qualification once", (filters) => {
  const summary = "Workspace summary.";
  const qualified = qualifyCommunitySummary(summary, filters);
  expect(qualified).toContain("Broader workspace context");
  expect(qualified).toContain(JSON.stringify(filters));
  expect(qualifyCommunitySummary(qualified, filters)).toBe(qualified);
});
