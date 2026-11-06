import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { buildEstimateCard } from "./estimate-card.js";
import { buildProfilerRules } from "./estimate-profiler-rules.js";
import { PAGE_RASTER_ROUTING } from "./page-raster-routing.js";
import { PAGE_TABLE_ROUTING } from "./page-table-routing.js";

const file = join(dirname(fileURLToPath(import.meta.url)), "../../estimate/profiler-rules.json");

describe("neutral profiler rules", () => {
  it("matches the committed profiler-rules.json (UPDATE_PROFILER_RULES=1 rewrites it)", () => {
    const expected = `${JSON.stringify(buildProfilerRules(), null, 1)}\n`;
    if (process.env.UPDATE_PROFILER_RULES === "1") writeFileSync(file, expected);
    expect(readFileSync(file, "utf8"), "routing rules changed: run UPDATE_PROFILER_RULES=1 pnpm --filter @docslurp/shared test estimate-profiler-rules").toBe(expected);
  });

  it("carries exactly the router's runtime thresholds and nothing priced", () => {
    const rules = buildProfilerRules();
    expect(rules.pageRasterRouting).toEqual(PAGE_RASTER_ROUTING);
    expect(rules.pageTableRouting).toEqual(PAGE_TABLE_ROUTING);
    expect(Object.keys(rules).sort()).toEqual(["pageRasterRouting", "pageTableRouting", "revision", "schema"]);
    expect(JSON.stringify(rules)).not.toMatch(/price|credit|rate|multiplier|plan|cents|dollar/i);
  });

  it("the card keeps its published routing subset, which agrees with the rules", () => {
    const card = buildEstimateCard().pageRasterRouting as Record<string, unknown>;
    expect(Object.keys(card)).toHaveLength(12);
    for (const [key, value] of Object.entries(card)) expect(value).toBe((PAGE_RASTER_ROUTING as Record<string, unknown>)[key]);
    expect(card).not.toHaveProperty("mixedScanMinCoverage");
  });
});
