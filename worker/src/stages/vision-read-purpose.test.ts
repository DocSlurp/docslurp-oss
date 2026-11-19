/**
 * Read budgets through execution: route plans carry them (stampReadBudgets), routed and triage hints merge them
 * (mergedReadBudgets: the stricter wins), region requests keep them (budgetedRegionTarget) and page tasks resolve them
 * (pageTaskHints: plan data first, a v2 payload only stricter).
 */
import { routePlanSchema, type RoutePlan } from "@docslurp/shared";
import { describe, expect, it } from "vitest";

import { ENCODING_MATH_READ_SIGNAL, ENCODING_READ_ONLY_SIGNAL, readBudgetOf, stricterReadBudget, TABLE_LEAK_ONLY_SIGNAL } from "./classify-route.js";
import { stampReadBudgets } from "./route-pages.js";
import { budgetedReadPurpose, budgetedRegionTarget, budgetHints, mergedReadBudgets, pageTaskHints } from "./vision-extract.js";
import { encodingReadPageCap } from "./classify-route.js";

const assignment = (pageNumber: number, targetId = "vlm:example", role = "extract-text") => ({
  pageNumber, scope: { kind: "page" }, targetId, role, reason: "test", estimate: { costUsd: 0.001, latencyMs: 10, pPass: 0.9 },
});

describe("readBudgetOf", () => {
  it("names the budget a triage decision authorized, encoding reads first", () => {
    expect(readBudgetOf({ ocrDecision: { signals: [ENCODING_READ_ONLY_SIGNAL, TABLE_LEAK_ONLY_SIGNAL] } })).toBe("encoding-read");
    expect(readBudgetOf({ ocrDecision: { signals: [TABLE_LEAK_ONLY_SIGNAL] } })).toBe("table-rescue");
    expect(readBudgetOf({ ocrDecision: { signals: [ENCODING_MATH_READ_SIGNAL] } })).toBe("encoding-read");
    expect(readBudgetOf({ ocrDecision: { signals: ["ocr-authorized:raster"] } })).toBeNull();
    expect(readBudgetOf({})).toBeNull();
    expect(stricterReadBudget("table-rescue", "encoding-read")).toBe("encoding-read");
    expect(stricterReadBudget(null, "table-rescue")).toBe("table-rescue");
    expect(stricterReadBudget(undefined, null)).toBeNull();
  });
});

describe("route plans persist the read budget with each assignment", () => {
  it("stamps pixel-needing assignments of budgeted pages; native and accept-text ones stay as written", () => {
    const base = routePlanSchema.shape.assignments.element;
    const plan = {
      assignments: [assignment(1), assignment(2), assignment(2, "native:text", "accept-text"), assignment(3)].map((a) => base.parse(a)),
    } as unknown as RoutePlan;
    const routing = { pages: [
      { pageNumber: 1, ocrDecision: { authorized: true, confidence: 0.8, signals: [ENCODING_READ_ONLY_SIGNAL] } },
      { pageNumber: 2, ocrDecision: { authorized: true, confidence: 0.7, signals: [TABLE_LEAK_ONLY_SIGNAL] } },
    ] } as never;
    const stamped = stampReadBudgets(plan, routing);
    expect(stamped.assignments.map((a) => a.readBudget)).toEqual(["encoding-read", "table-rescue", undefined, undefined]);
    // The schema keeps it: a stored plan read back still carries the budget.
    expect(base.parse(stamped.assignments[0]).readBudget).toBe("encoding-read");
    expect(() => base.parse({ ...stamped.assignments[0], readBudget: "page" })).toThrow();
    expect(stampReadBudgets(plan, null)).toBe(plan);
  });

  it("routed execution takes the stricter of the plan's stamp and page triage, for groups, fallbacks and regions", () => {
    const triage = { encodingReadPages: new Set([1]), tableRescuePages: new Set([2]) };
    // The plan was made from an older triage: page 2 is an encoding read there, page 3 a table rescue.
    const budgets = mergedReadBudgets(triage, [{ pageNumber: 2, readBudget: "encoding-read" }, { pageNumber: 3, readBudget: "table-rescue" }, { pageNumber: 4 }]);
    expect([...budgets].sort()).toEqual([[1, "encoding-read"], [2, "encoding-read"], [3, "table-rescue"]]);
    const hints = budgetHints(budgets);
    expect(budgetedReadPurpose(hints, 2, 100)).toEqual(["encoding-read", { documentPageLimit: encodingReadPageCap(100) }]);
    expect(budgetedReadPurpose(hints, 4, 100)).toEqual(["page", {}]);
    expect(budgetedRegionTarget(hints, 1, 100)).toEqual(["encoding-read", { documentPageLimit: encodingReadPageCap(100), scope: "region" }]);
    expect(budgetedRegionTarget(hints, 4, 100)).toEqual(["region", {}]);
  });
});

describe("page task payloads are versioned; the plan data decides their purpose", () => {
  it("a legacy payload's purpose is ignored; a v2 payload can only make the read stricter", () => {
    const purposeOf = (hints: ReturnType<typeof pageTaskHints>) => budgetedReadPurpose(hints, 7, 100)[0];
    // Legacy (no version): only the trusted plan data.
    expect(purposeOf(pageTaskHints({ pageNumber: 7 }, "encoding-read"))).toBe("encoding-read");
    expect(purposeOf(pageTaskHints({ pageNumber: 7, readPurpose: "encoding-read" }, null))).toBe("page");
    // v2: the stricter of payload and plan.
    expect(purposeOf(pageTaskHints({ pageNumber: 7, payloadVersion: 2 }, "table-rescue"))).toBe("table-rescue");
    expect(purposeOf(pageTaskHints({ pageNumber: 7, payloadVersion: 2, readPurpose: "encoding-read" }, "table-rescue"))).toBe("encoding-read");
    expect(purposeOf(pageTaskHints({ pageNumber: 7, payloadVersion: 2, readPurpose: "table-rescue" }, null))).toBe("table-rescue");
    expect(purposeOf(pageTaskHints({ pageNumber: 7, payloadVersion: 2 }, null))).toBe("page");
  });
});
