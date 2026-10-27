import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { routePlanSchema, type AdaptivePageRoute } from "@docslurp/shared";
import { classifyAdaptivePage } from "../../stages/classify-route.js";
import { HeuristicRouter, heuristicWantsVision } from "./heuristic.js";
import { BIG_BUDGET, makePage, testCatalog } from "../testing.js";

const fixtures = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../testdata/pdf-fixtures/document-routing-eval-v1.json", import.meta.url)), "utf8"),
) as { fixtures: Array<{ id: string; expected: { pages?: Array<{ pageNumber: number; route: AdaptivePageRoute; extractorHint: string }> } }> };

const catalog = testCatalog();

describe("HeuristicRouter", () => {
  it("sends exactly the pages classify-route marks vision-rescue to a vision target (routing fixtures)", async () => {
    let checked = 0;
    for (const fx of fixtures.fixtures) {
      for (const pg of fx.expected.pages ?? []) {
        const page = makePage({ pageNumber: pg.pageNumber, route: pg.route, hint: pg.extractorHint });
        const plan = await new HeuristicRouter().plan([page], catalog, BIG_BUDGET, "cost-quality");
        const a = plan.assignments[0]!;
        const usesVision = a.targetId.startsWith("vlm:");
        expect(usesVision, `${fx.id} p${pg.pageNumber}`).toBe(pg.extractorHint === "vision-rescue");
        expect(usesVision).toBe(heuristicWantsVision(pg.route, pg.extractorHint));
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(8);
  });

  it("re-runs classify-route when page text is supplied", async () => {
    const text = "";
    const entry = classifyAdaptivePage(1, text);
    const page = makePage({ route: "straightforward-text", hint: "cheap-text" });
    const plan = await new HeuristicRouter({ pageText: () => text }).plan([page], catalog, BIG_BUDGET, "cost-quality");
    expect(plan.assignments[0]!.targetId.startsWith("vlm:")).toBe(entry.extractorHint === "vision-rescue");
  });

  it("produces a valid RoutePlan@v2 with estimates and respects the budget guard", async () => {
    const pages = [makePage({ pageNumber: 1, route: "handwriting-or-degraded", hint: "vision-rescue" }), makePage({ pageNumber: 2 })];
    const plan = await new HeuristicRouter().plan(pages, catalog, BIG_BUDGET, "cost-quality");
    expect(() => routePlanSchema.parse(plan)).not.toThrow();
    expect(plan.routerKind).toBe("heuristic");
    expect(plan.chunkEstimate.extractionCostUsd).toBeGreaterThan(0);
    const tight = await new HeuristicRouter().plan(pages, catalog, { limitUsd: 0, marginFloor: 0 }, "cost-quality");
    expect(tight.chunkEstimate.overBudgetActions.length).toBeGreaterThan(0);
  });
  it("never accepts native text silently when vision is wanted but no vision target exists", async () => {
    const scan = makePage({ pageNumber: 1, route: "handwriting-or-degraded", hint: "vision-rescue" });
    const nativeOnly = catalog.filter((t) => t.kind === "native");
    const plan = await new HeuristicRouter().plan([scan], nativeOnly, BIG_BUDGET, "cost-quality");
    expect(plan.assignments[0]!.role).toBe("accept-text");
    expect(plan.assignments[0]!.reason).toContain("vision-unavailable");
    expect(plan.attention).toEqual([expect.objectContaining({ pageNumber: 1, outcome: "flagged", features: ["vision-target-unavailable"] })]);
    expect(() => routePlanSchema.parse(plan)).not.toThrow();
  });

  it("merges an unavailable-vision flag into the page's existing attention entry", async () => {
    const scan = { ...makePage({ pageNumber: 1, route: "handwriting-or-degraded", hint: "vision-rescue" }), unusualFeatures: ["javascript"] };
    const plan = await new HeuristicRouter().plan([scan], catalog.filter((t) => t.kind === "native"), BIG_BUDGET, "cost-quality");
    expect(plan.attention).toHaveLength(1);
    expect(plan.attention[0]!.features).toEqual(["javascript", "vision-target-unavailable"]);
  });

  it("falls back to a local OCR target when no vision target exists", async () => {
    const scan = makePage({ pageNumber: 1, route: "handwriting-or-degraded", hint: "vision-rescue" });
    const native = catalog.find((t) => t.kind === "native")!;
    const ocr = { ...native, id: "ocr:local-test", kind: "local-ocr" as const, roles: ["ocr" as const],
      capabilities: { ...native.capabilities, imageInput: true, usesNativeTextLayer: false } };
    const plan = await new HeuristicRouter().plan([scan], [native, ocr], BIG_BUDGET, "cost-quality");
    expect(plan.assignments[0]).toMatchObject({ targetId: "ocr:local-test", role: "ocr" });
    expect(plan.attention).toEqual([]);
  });
});
