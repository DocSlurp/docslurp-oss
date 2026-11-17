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
      const rows = [
        { metric: BILLABLE_UNIT_METRICS.fastPage, amount: 10, cost_cents: 0.05, events: 1 },
        { metric: BILLABLE_UNIT_METRICS.ocrPage, amount: 4, cost_cents: 0.16, events: 4 },
        { metric: BILLABLE_UNIT_METRICS.richPage, amount: 2, cost_cents: 0.5, events: 2 },
      ];
      const text = strings.join("");
      if (text.includes("group by au.metric")) return Promise.resolve(rows);
      // The final-class page counts (one upgraded page already moved from Scan to Vision by the query).
      if (text.includes("page_charges")) return Promise.resolve([{ fast_pages: 10, ocr_pages: 3, rich_page_reads: 2, rich_aggregate_pages: 0 }]);
      return { strings, values };
    }) as never;
    const usage = await orgUnitUsage("org-a", null, client);
    expect(usage).toMatchObject({ fastPages: 10, ocrPages: 3, richPages: 2 });
    expect(usage.ingestCredits).toBeCloseTo(0.71);
    // Both the credit and the page-count query are bound to the organization asked for.
    expect(calls.filter((values) => values.includes("org-a"))).toHaveLength(2);
  });
});
