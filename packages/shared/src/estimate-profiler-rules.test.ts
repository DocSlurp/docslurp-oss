import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { buildProfilerRules } from "./estimate-profiler-rules.js";

const RULES = fileURLToPath(new URL("../../estimate/profiler-rules.json", import.meta.url));

describe("offline profiler rules", () => {
  it("match the committed profiler-rules.json", () => {
    const expected = `${JSON.stringify(buildProfilerRules(), null, 1)}\n`;
    if (process.env.UPDATE_PROFILER_RULES === "1") writeFileSync(RULES, expected);
    expect(readFileSync(RULES, "utf8")).toBe(expected);
  });

  it("hold no prices", () => {
    const text = JSON.stringify(buildProfilerRules()).toLowerCase();
    for (const word of ["credit", "price", "rich", "fast", "cost", "dollar", "cents", "free"]) expect(text).not.toContain(word);
  });
});
