import { describe, expect, it, vi } from "vitest";
import { BILLABLE_UNIT_METRICS, PAGE_CHARGE_METRICS } from "@docslurp/shared";

vi.mock("../db.js", () => ({ sql: vi.fn() }));

const { INGEST_UNIT_METRICS, orgUnitUsage } = await import("../services/usage-attribution.js");

describe("ingest spend metrics", () => {
  it("counts exported charts and diagrams as ingest spend", () => {
    expect(INGEST_UNIT_METRICS).toContain(BILLABLE_UNIT_METRICS.chartExport);
  });

  it("counts every page class (Fast, OCR, Rich) as ingest spend", () => {
    for (const metric of PAGE_CHARGE_METRICS) expect(INGEST_UNIT_METRICS).toContain(metric);
  });

  it("reports page counts by final class and credits as summed charges, scoped to the organization it was asked for", async () => {
    const calls: unknown[][] = [];
    // A stand-in SQL client: fragments resolve to themselves, the final query returns per-metric sums.
    const client = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      // Per-metric sums with each class's final page count (one upgraded page already moved from Scan to Vision).
      const rows = [
        { metric: BILLABLE_UNIT_METRICS.fastPage, amount: 10, cost_cents: 0.05, events: 0, final_pages: 10 },
        { metric: BILLABLE_UNIT_METRICS.ocrPage, amount: 4, cost_cents: 0.16, events: 0, final_pages: 3 },
        { metric: BILLABLE_UNIT_METRICS.richPage, amount: 2, cost_cents: 0.5, events: 0, final_pages: 2 },
      ];
      return strings.join("").includes("with charges as materialized") ? Promise.resolve(rows) : { strings, values };
    }) as never;
    const usage = await orgUnitUsage("org-a", null, client);
    expect(usage).toMatchObject({ fastPages: 10, ocrPages: 3, richPages: 2 });
    expect(usage.ingestCredits).toBeCloseTo(0.71);
    // One pass, bound to the organization asked for (the indexed prefilter, the derived org and the outer filter).
    expect(calls.flat().filter((value) => value === "org-a").length).toBeGreaterThanOrEqual(3);
    expect(calls.flat()).not.toContain("org-b");
  });
});
