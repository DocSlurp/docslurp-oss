import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { routePlanSchema } from "@docslurp/shared";
import { BIG_BUDGET, makePage, testCatalog, testPack } from "../testing.js";
import {
  FreeFeatureRouter, documentContext, freeFeatureNeeds, freeFeatureScores, loadFreeFeaturePack, parseFreeFeaturePack,
} from "./free-features.js";

const shipped = parseFreeFeaturePack(
  JSON.parse(readFileSync(fileURLToPath(new URL("../policies/page-router-free-v1.json", import.meta.url)), "utf8")),
);
const th = shipped.thresholds;
const noMathDoc = { maxMathGlyphRatio: 0 };

describe("free-feature router scores", () => {
  it("accepts an ok text layer with no table or math evidence", () => {
    const s = freeFeatureScores(makePage({ words: 500, vectors: 5 }), noMathDoc, th);
    expect(s).toMatchObject({ accept: true, scanned: 0 });
  });

  it("never accepts a page without an ok text layer", () => {
    for (const textLayer of ["absent", "unknown", "suspect", "ocr-layer"] as const) {
      const s = freeFeatureScores(makePage({ textLayer, words: textLayer === "absent" ? 0 : 300 }), noMathDoc, th);
      expect(s.accept, textLayer).toBe(false);
    }
    expect(freeFeatureScores(makePage({ textLayer: "unknown", words: 0 }), noMathDoc, th).scanned).toBeGreaterThanOrEqual(0.5);
    expect(freeFeatureScores(makePage({ textLayer: "ocr-layer", words: 300 }), noMathDoc, th).scanned).toBeLessThan(0.9);
  });

  it("treats a full-page image with a handful of words as a scan even when the layer reads ok", () => {
    const s = freeFeatureScores(makePage({ words: 12, fullPageImage: true, images: [{ coverage: 1 }] }), noMathDoc, th);
    expect(s).toMatchObject({ accept: false, scanned: 0.9 });
  });

  it("escalates at the ruled-table threshold, not below it", () => {
    expect(freeFeatureScores(makePage({ tableRule: th.tableRuleScoreMin - 1 }), noMathDoc, th).accept).toBe(true);
    const s = freeFeatureScores(makePage({ tableRule: th.tableRuleScoreMin }), noMathDoc, th);
    expect(s.accept).toBe(false);
    expect(s.needsTables).toBeGreaterThanOrEqual(0.5);
  });

  it("escalates math from glyphs or from formulas drawn as vector paths", () => {
    expect(freeFeatureScores(makePage({ math: th.mathGlyphRatioMin }), noMathDoc, th).accept).toBe(false);
    expect(freeFeatureScores(makePage({ math: th.mathGlyphRatioMin / 3 }), noMathDoc, th).accept).toBe(true);
    const words = 200;
    expect(freeFeatureScores(makePage({ words, vectors: words * th.vectorPathsPerWordMin }), noMathDoc, th).needsMath).toBeGreaterThanOrEqual(0.5);
    expect(freeFeatureScores(makePage({ words, vectors: 20 }), noMathDoc, th).accept).toBe(true);
  });

  it("lowers the math bar inside a math-dense document (cross-page regime)", () => {
    const sparse = makePage({ pageNumber: 2, math: th.docMathPageGlyphRatioMin });
    const dense = makePage({ pageNumber: 1, math: th.docMathGlyphRatioMin * 2 });
    expect(freeFeatureScores(sparse, noMathDoc, th).accept).toBe(true);
    expect(freeFeatureScores(sparse, documentContext([dense, sparse]), th).accept).toBe(false);
  });

  it("rejects malformed packs", () => {
    expect(() => parseFreeFeaturePack({ schemaVersion: "free-feature-router@v1", policyVersion: "x", thresholds: { ...th, tableRuleScoreMin: -1 } })).toThrow();
    expect(() => parseFreeFeaturePack({ schemaVersion: "other" })).toThrow();
    expect(loadFreeFeaturePack().policyVersion).toBe("page-router-free-v1");
  });
});

describe("FreeFeatureRouter", () => {
  it("plans accept-text for prose, a non-native target for scans, tables and math", async () => {
    const pages = [
      makePage({ pageNumber: 1, words: 600 }),
      makePage({ pageNumber: 2, textLayer: "unknown", words: 0, fullPageImage: true, images: [{ coverage: 1 }] }),
      makePage({ pageNumber: 3, tableRule: 40 }),
      makePage({ pageNumber: 4, math: 0.03 }),
    ];
    const needs = freeFeatureNeeds(pages, shipped);
    expect(needs.map((n) => n.pTrustTextLayer >= 0.7)).toEqual([true, false, false, false]);
    const plan = await new FreeFeatureRouter({ pack: testPack(), freePack: shipped }).plan(pages, testCatalog(), BIG_BUDGET, "cost-quality");
    expect(routePlanSchema.safeParse(plan).success).toBe(true);
    const first = (n: number) => plan.assignments.find((a) => a.pageNumber === n)!;
    expect(first(1).targetId).toBe("native:accept-text-layer");
    for (const n of [2, 3, 4]) expect(first(n).targetId, `page ${n}`).not.toBe("native:accept-text-layer");
    expect(plan.routerId).toBe("baseline:free-features:page-router-free-v1");
  });
});
