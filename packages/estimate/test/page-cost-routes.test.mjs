// The cost-route cases the Rust profiler's port is tested against (page-cost-routes.json, read by src/probe/cost_route.rs)
// must be exactly what @docslurp/shared's `pageCostRoute` gives for them (buildPageCostRouteCases). The rule and its port
// drift apart only by failing here or in `cargo test`. UPDATE_PAGE_COST_ROUTES=1 rewrites the file from the generator.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";

import { buildPageCostRouteCases } from "@docslurp/shared";

const CASES = new URL("../page-cost-routes.json", import.meta.url);

describe("page-cost-routes.json", () => {
  it("matches what @docslurp/shared's pageCostRoute gives (UPDATE_PAGE_COST_ROUTES=1 rewrites it)", () => {
    const expected = `${JSON.stringify(buildPageCostRouteCases(), null, 1)}\n`;
    if (process.env.UPDATE_PAGE_COST_ROUTES === "1") writeFileSync(CASES, expected);
    assert.equal(readFileSync(CASES, "utf8"), expected, "the cost route rule changed: run UPDATE_PAGE_COST_ROUTES=1 node --test packages/estimate/test/page-cost-routes.test.mjs");
  });
});
