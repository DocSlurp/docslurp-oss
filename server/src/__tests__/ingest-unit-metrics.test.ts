import { describe, expect, it } from "vitest";
import { BILLABLE_UNIT_METRICS } from "@docslurp/shared";

import { INGEST_UNIT_METRICS } from "../services/usage-attribution.js";

describe("ingest spend metrics", () => {
  it("counts exported charts and diagrams as ingest spend", () => {
    expect(INGEST_UNIT_METRICS).toContain(BILLABLE_UNIT_METRICS.chartExport);
  });
});
