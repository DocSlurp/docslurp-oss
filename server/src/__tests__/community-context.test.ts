import { expect, it } from "vitest";
import { qualifyCommunitySummary } from "../search/community-context.js";

it("retains community summaries and qualifies broader evidence in tagged context", () => {
  const summary = "Revenue increased across departments.";
  expect(qualifyCommunitySummary(summary)).toBe(summary);
  const qualified = qualifyCommunitySummary(summary, ["finance"]);
  expect(qualified).toContain('selected document tags ["finance"]');
  expect(qualified).toContain("may include documents outside that selection");
  expect(qualified.endsWith(summary)).toBe(true);
});
