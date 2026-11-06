import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildProfilerRules, LAYOUT_GRID_RULES } from "./estimate-profiler-rules.js";
import { sha256Hex } from "./hash.js";
import { PAGE_RASTER_ROUTING } from "./page-raster-routing.js";
import { PAGE_TABLE_ROUTING } from "./page-table-routing.js";

const RULES = fileURLToPath(new URL("../../estimate/profiler-rules.json", import.meta.url));

describe("offline profiler rules", () => {
  it("match the committed profiler-rules.json", () => {
    const expected = `${JSON.stringify(buildProfilerRules(), null, 1)}\n`;
    if (process.env.UPDATE_PROFILER_RULES === "1") writeFileSync(RULES, expected);
    expect(readFileSync(RULES, "utf8")).toBe(expected);
  });

  it("build grids with the layout walker's own constants", () => {
    const walker = readFileSync(fileURLToPath(new URL("../../../worker/scripts/pdf_layout_facts.py", import.meta.url)), "utf8");
    const constant = (name: string) => Number(new RegExp(`^${name} = ([0-9_.]+)`, "m").exec(walker)?.[1]?.replaceAll("_", ""));
    expect({
      ruleThicknessPt: constant("RULE_THICKNESS_PT"), ruleMinLengthPt: constant("RULE_MIN_LENGTH_PT"), ruleTouchPt: constant("RULE_TOUCH_PT"),
      coverageRaster: constant("COVERAGE_RASTER"), maxRulesPerPage: constant("MAX_RULES_PER_PAGE"), maxWordsPerPage: constant("MAX_ANCHOR_WORDS"),
    }).toEqual(LAYOUT_GRID_RULES);
  });

  it("carry exactly the router's runtime thresholds, and a revision that hashes the rest", () => {
    const { revision, ...body } = buildProfilerRules();
    expect(body.pageRasterRouting).toEqual(PAGE_RASTER_ROUTING);
    expect(body.pageTableRouting).toEqual(PAGE_TABLE_ROUTING);
    expect(revision).toBe(sha256Hex(JSON.stringify(body)));
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hold no prices", () => {
    const text = JSON.stringify(buildProfilerRules()).toLowerCase();
    for (const word of ["credit", "price", "rich", "fast", "cost", "dollar", "cents", "free"]) expect(text).not.toContain(word);
  });
});
