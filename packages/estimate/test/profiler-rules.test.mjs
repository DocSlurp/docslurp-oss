// The neutral profiler rules this package bundles (profiler-rules.json, embedded in the Rust profiler and the WASM module)
// must be exactly what @docslurp/shared generates from the router's runtime constants (buildProfilerRules). The estimator
// depends on shared; shared never reads this package. UPDATE_PROFILER_RULES=1 rewrites the file from the generator.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildProfilerRules } from "@docslurp/shared";

const RULES = new URL("../profiler-rules.json", import.meta.url);

describe("profiler-rules.json", () => {
  it("matches what @docslurp/shared generates (UPDATE_PROFILER_RULES=1 rewrites it)", () => {
    const expected = `${JSON.stringify(buildProfilerRules(), null, 1)}\n`;
    if (process.env.UPDATE_PROFILER_RULES === "1") writeFileSync(RULES, expected);
    assert.equal(readFileSync(RULES, "utf8"), expected, "routing rules changed: run UPDATE_PROFILER_RULES=1 node --test packages/estimate/test/profiler-rules.test.mjs");
  });
});
