import { describe, expect, it } from "vitest";
import { assessAttention, attentionForPages } from "./attention.js";
import { assemblePlan, needsFromFeatures, planPages } from "./planner.js";
import { createPolicyEstimator } from "./policy.js";
import { BIG_BUDGET, makePage, testCatalog, testPack } from "./testing.js";

const catalog = testCatalog();
const pack = testPack();
const estimator = createPolicyEstimator(pack);

function plan(features: string[] | undefined) {
  const page = { ...makePage({ pageNumber: 1 }), ...(features ? { unusualFeatures: features } : {}) };
  const r = planPages({ needs: [needsFromFeatures(page)], pages: [page], catalog, objective: "cost-quality", estimator });
  return { page, ...r };
}

describe("H9 attention rules", () => {
  it("pages without unusual features produce no attention", () => {
    expect(assessAttention(makePage({ pageNumber: 1 })).attention).toBeNull();
    expect(plan(undefined).attention).toEqual([]);
    expect(plan(["link-uri", "rotated-page", "huge-page", "type3-font"]).attention).toEqual([]);
  });

  it("locked document -> needs-attention + explicit skip assignment", () => {
    const r = plan(["encrypted-user-password"]);
    expect(r.attention).toMatchObject([{ pageNumber: 1, outcome: "skipped", features: ["encrypted-user-password"] }]);
    expect(r.planned).toHaveLength(1);
    expect(r.planned[0]!.assignment).toMatchObject({ role: "skip", targetId: "skip" });
    expect(r.planned[0]!.assignment.reason).toContain("needs-attention");
  });

  it("hidden layer / javascript / attachment -> flagged, extraction still happens", () => {
    for (const f of ["ocg-hidden", "javascript", "attachment"]) {
      const r = plan([f]);
      expect(r.attention).toMatchObject([{ outcome: "flagged", features: [f] }]);
      expect(r.planned.map((p) => p.assignment.role)).toEqual(["accept-text"]);
    }
  });

  it("form/annotation text is not discarded: text-layer-only role becomes a rendering target", () => {
    for (const f of ["acroform-filled", "annotation-text", "annotation-freetext"]) {
      const r = plan([f]);
      expect(r.attention[0]).toMatchObject({ outcome: "flagged", features: [f] });
      const a = r.planned[0]!.assignment;
      expect(a.role).toBe("ocr");
      expect(a.reason).toContain("needs-attention");
      const t = catalog.find((c) => c.id === a.targetId)!;
      expect(t.capabilities.usesNativeTextLayer).toBe(false);
    }
  });

  it("highlight annotations flag but keep the text-layer path", () => {
    const r = plan(["annotation-highlight"]);
    expect(r.attention[0]!.outcome).toBe("flagged");
    expect(r.planned[0]!.assignment.role).toBe("accept-text");
  });

  it("assemblePlan carries attention into the RoutePlan; attentionForPages lists affected pages only", () => {
    const r = plan(["acroform-filled"]);
    const { plan: p } = assemblePlan({
      documentId: "d", runId: "r", routerId: "t", routerKind: "baseline", objective: "cost-quality", policyVersion: "t",
      planned: r.planned, attention: r.attention, budget: BIG_BUDGET, catalog,
    });
    expect(p.attention).toHaveLength(1);
    expect(attentionForPages([r.page, makePage({ pageNumber: 2 })])).toHaveLength(1);
  });
});
