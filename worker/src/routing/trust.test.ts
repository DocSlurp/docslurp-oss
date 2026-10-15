import { describe, expect, it } from "vitest";

import { needsFromFeatures } from "./planner.js";
import { BIG_BUDGET, makePage, testCatalog, testPack } from "./testing.js";
import { TRUST_RULE, freeTrustVerdict, insetGateCandidates } from "./trust.js";
import { BaselineRouter } from "./routers/baseline.js";

describe("free trust cascade", () => {
  it("trusts ok pages and withholds trust from suspect, absent and garbled layers", () => {
    expect(freeTrustVerdict(makePage({ words: 400 }))).toMatchObject({ trusted: true, reason: "text-layer-ok" });
    expect(freeTrustVerdict(makePage({ words: 40, textLayer: "suspect" })).trusted).toBe(false);
    expect(freeTrustVerdict(makePage({ words: 0 }))).toMatchObject({ trusted: false, reason: "no-text-layer" });
    const garbled = makePage({ words: 400 });
    garbled.features.native.garbled = true;
    expect(freeTrustVerdict(garbled)).toMatchObject({ trusted: false, reason: "garbled-text-layer" });
  });

  it("trusts an OCR layer only when the band re-OCR agrees", () => {
    expect(freeTrustVerdict(makePage({ textLayer: "ocr-layer", ocrAgreement: 0.8 }))).toMatchObject({ trusted: true, reason: "ocr-layer-agrees" });
    expect(freeTrustVerdict(makePage({ textLayer: "ocr-layer", ocrAgreement: TRUST_RULE.ocrLayerAgreementMin }))).toMatchObject({ trusted: true });
    expect(freeTrustVerdict(makePage({ textLayer: "ocr-layer", ocrAgreement: 0.2 }))).toMatchObject({ trusted: false, reason: "ocr-layer-disagrees" });
    expect(freeTrustVerdict(makePage({ textLayer: "ocr-layer", ocrAgreement: null }))).toMatchObject({ trusted: false, reason: "ocr-layer-unverified" });
    expect(freeTrustVerdict(makePage({ textLayer: "ocr-layer" }))).toMatchObject({ trusted: false, reason: "ocr-layer-unverified" });
  });

  it("math gate keeps a math page out of accept-text-only", () => {
    const verdict = freeTrustVerdict(makePage({ words: 400, math: TRUST_RULE.mathGlyphRatio }));
    expect(verdict).toMatchObject({ trusted: false, mathGated: true, reason: "math-glyphs" });
    expect(freeTrustVerdict(makePage({ words: 400, math: TRUST_RULE.mathGlyphRatio / 2 })).trusted).toBe(true);
  });

  it("lists only insets covering 2-85% of the page as gate candidates", () => {
    const page = makePage({ images: [{ coverage: 0.01 }, { coverage: 0.02 }, { coverage: 0.4 }, { coverage: 0.85 }, { coverage: 0.95 }] });
    expect(insetGateCandidates(page).map((i) => i.index)).toEqual([1, 2]);
  });

  it("feeds the free-feature needs: verified OCR layer is trusted, math pages are not accept-text-only", () => {
    expect(needsFromFeatures(makePage({ textLayer: "ocr-layer", ocrAgreement: 0.9, words: 300 })).pTrustTextLayer).toBeGreaterThanOrEqual(0.7);
    expect(needsFromFeatures(makePage({ textLayer: "ocr-layer", ocrAgreement: 0.1, words: 300 })).pTrustTextLayer).toBeLessThan(0.7);
    expect(needsFromFeatures(makePage({ words: 400, math: 0.05 })).pTrustTextLayer).toBeLessThan(0.7);
  });

  it("the baseline router follows the same rule end to end", async () => {
    const plan = await new BaselineRouter({ pack: testPack() }).plan(
      [makePage({ pageNumber: 1, words: 400 }), makePage({ pageNumber: 2, words: 400, math: 0.05 }), makePage({ pageNumber: 3, textLayer: "ocr-layer", ocrAgreement: 0.9, words: 300 })],
      testCatalog(),
      BIG_BUDGET,
      "cost-quality",
    );
    const roles = (n: number) => plan.assignments.filter((a) => a.pageNumber === n).map((a) => a.role);
    expect(roles(1)).toEqual(["accept-text"]);
    expect(roles(2)).not.toContain("accept-text");
    expect(roles(3)).toEqual(["accept-text"]);
  });
});
