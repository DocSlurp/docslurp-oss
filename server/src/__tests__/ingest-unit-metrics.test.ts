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

  it("reports OCR pages beside Fast and Rich, scoped to the organization it was asked for", async () => {
    const calls: unknown[][] = [];
    // A stand-in SQL client: fragments resolve to themselves, the final query returns per-metric sums.
    const client = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push(values);
      const rows = [
        { metric: BILLABLE_UNIT_METRICS.fastPage, amount: 10, cost_cents: 0.05, events: 1 },
        { metric: BILLABLE_UNIT_METRICS.ocrPage, amount: 4, cost_cents: 0.16, events: 4 },
        { metric: BILLABLE_UNIT_METRICS.richPage, amount: 2, cost_cents: 0.5, events: 2 },
      ];
      return strings.join("").includes("group by au.metric") ? Promise.resolve(rows) : { strings, values };
    }) as never;
    const usage = await orgUnitUsage("org-a", null, client);
    expect(usage).toMatchObject({ fastPages: 10, ocrPages: 4, richPages: 2 });
    expect(usage.ingestCredits).toBeCloseTo(0.71);
    expect(calls.at(-1)).toContain("org-a");
  });
});
