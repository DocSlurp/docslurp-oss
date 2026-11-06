import { afterEach, describe, expect, it } from "vitest";

import {
  DISTINCT_TEST_PRICING,
  estimateRequestSchema,
  installTestPricing,
  quoteEstimate,
  resetPricingProviderForTests,
  type FileProfile,
} from "../index.js";

afterEach(() => resetPricingProviderForTests());

const BILLED = { STRIPE_SECRET_KEY: "sk_test" };

function scan(pages: number, bytes = pages * 200_000): { name: string; size: number; profile: FileProfile } {
  const sampled = Math.min(24, pages);
  return {
    name: `scan-${pages}.pdf`,
    size: bytes,
    profile: {
      schema: 1, profiler: "test", kind: "pdf", format: "pdf", bytes, pages,
      pdf: {
        sampledPages: sampled, textLayerPages: 0, wordsPerPage: [sampled, 0, 0, 0, 0, 0], lowTextPages: sampled, blankPages: 0,
        rasterPages: sampled, imagePages: sampled, images: sampled, imageCoverage: [0, 0, 0, 0, sampled], furnitureImages: 0,
        layoutHeavyPages: 0, vectorHeavyPages: 0, unmappedFontPages: 0, drawnContent: false, budgetExhausted: false,
        sampledWords: 0, medianPageAreaSqIn: 94, maxPageAreaSqIn: 94,
      sampledChars: 0, sampledTextLines: 0, charsByFontSize: [0, 0, 0, 0, 0], invisibleChars: 0, offCropChars: 0,
      sampledTextEquivalents: sampled, sampledAreaEquivalents: sampled, sampledPageEquivalents: sampled, maxPageEquivalents: 1, textEquivalentsPerPage: [sampled, 0, 0, 0, 0, 0, 0], areaEquivalentsPerPage: [sampled, 0, 0, 0, 0, 0, 0, 0], densePages: 0, medianPageWidthPt: 612, medianPageHeightPt: 792, maxPageWidthPt: 612, maxPageHeightPt: 792, offPageChars: 0, tinyCharsDropped: 0, textEstimatedPages: 0,
      },
    },
  };
}

describe("quoteEstimate", () => {
  it("returns ingest, monthly hosting and usage separately, with neutral lines and the pricing version", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const quote = quoteEstimate({ files: [scan(40)], settings: { searchesPerMonth: 1_000, chatAnswersPerMonth: 10 } }, { env: BILLED });
    expect(quote).toMatchObject({ kind: "estimate", pricingVersion: "test-1", billing: "enforced", files: { total: 1, profiled: 1 }, pages: { low: 40, high: 40 } });
    expect(Date.parse(quote.validUntil)).toBeGreaterThan(Date.now());
    expect(quote.ingest.credits!.high).toBeGreaterThan(0);
    expect(quote.hosting.bytes.low).toBeGreaterThan(8_000_000);
    expect(quote.hosting.credits!.low).toBeCloseTo(quote.hosting.creditsPerMonth!.low * 12, 3);
    expect(quote.usage.creditsPerMonth!.low).toBeGreaterThan(0);
    expect(quote.lines.map((line) => [line.id, line.period])).toEqual([["pages", "once"], ["storage", "month"], ["search", "month"], ["chat", "month"]]);
    // Lines carry labels and credits only: no rates, multipliers or free/zero flags.
    for (const line of quote.lines) expect(Object.keys(line).sort()).toEqual(["credits", "id", "label", "period"]);
  });

  it("moves with the knobs: on-demand indexing changes hosting, quality and speed boost change ingest", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const files = [scan(40)];
    const base = quoteEstimate({ files }, { env: BILLED });
    const lean = quoteEstimate({ files: [{ ...files[0]!, profile: { ...files[0]!.profile, pdf: { ...files[0]!.profile.pdf!, sampledWords: 9_000, sampledChars: 54_000, charsByFontSize: [0, 0, 0, 54_000, 0] } } }], settings: { indexing: "on-demand" } }, { env: BILLED });
    const full = quoteEstimate({ files: [{ ...files[0]!, profile: { ...files[0]!.profile, pdf: { ...files[0]!.profile.pdf!, sampledWords: 9_000, sampledChars: 54_000, charsByFontSize: [0, 0, 0, 54_000, 0] } } }] }, { env: BILLED });
    expect(lean.hosting.bytes.high).toBeLessThan(full.hosting.bytes.high);
    const fast = quoteEstimate({ files, settings: { quality: "fast" } }, { env: BILLED });
    expect(fast.ingest.credits!.high).toBeLessThan(base.ingest.credits!.high);
    const boosted = quoteEstimate({ files, settings: { speedBoost: true } }, { env: BILLED });
    expect(boosted.ingest.credits!.high).toBeGreaterThan(base.ingest.credits!.high);
  });

  it("quotes a stuffed document at the page equivalents billing will measure, never below its pages", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const ordinary = scan(1);
    const stuffed = { ...ordinary, profile: { ...ordinary.profile, pdf: { ...ordinary.profile.pdf!, sampledChars: 40_000, charsByFontSize: [40_000, 0, 0, 0, 0], sampledTextEquivalents: 12, sampledPageEquivalents: 12, maxPageEquivalents: 12, textEquivalentsPerPage: [0, 0, 0, 0, 1, 0, 0], densePages: 1 } } };
    const plain = quoteEstimate({ files: [ordinary] }, { env: BILLED });
    const packed = quoteEstimate({ files: [stuffed] }, { env: BILLED });
    expect(plain.pages).toEqual({ low: 1, high: 1 });
    expect(packed.pages).toEqual({ low: 12, high: 12 });
    expect(packed.ingest.credits!.low).toBeGreaterThan(plain.ingest.credits!.low);
    expect(packed.hosting.bytes.high).toBeGreaterThan(plain.hosting.bytes.high);
    // A profile cannot claim fewer equivalents than pages sampled: clamped up to one a page.
    const understated = { ...ordinary, profile: { ...ordinary.profile, pdf: { ...ordinary.profile.pdf!, sampledPageEquivalents: 0, sampledTextEquivalents: 0, sampledAreaEquivalents: 0 } } };
    expect(quoteEstimate({ files: [understated] }, { env: BILLED }).pages).toEqual({ low: 1, high: 1 });
  });

  it("shows no credits where billing is disabled, but still the pages, bytes and time", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const quote = quoteEstimate({ files: [scan(10)] }, { env: {} });
    expect(quote).toMatchObject({ billing: "disabled", ingest: { credits: null }, hosting: { creditsPerMonth: null, credits: null }, lines: [] });
    expect(quote.hosting.bytes.high).toBeGreaterThan(0);
  });

  it("refuses unknown knobs and hostile profiles at the schema", () => {
    expect(estimateRequestSchema.safeParse({ files: [scan(1)], settings: { margin: 0 } }).success).toBe(false);
    expect(estimateRequestSchema.safeParse({ files: [{ ...scan(1), profile: { ...scan(1).profile, free: true } }] }).success).toBe(false);
    expect(estimateRequestSchema.safeParse({ files: [scan(1)], settings: { hostingMonths: 600 } }).success).toBe(false);
    expect(estimateRequestSchema.safeParse({ files: Array.from({ length: 1_001 }, () => scan(1)) }).success).toBe(false);
  });

  it("re-quotes 1,000 profiled files well inside the interactive budget", () => {
    installTestPricing(DISTINCT_TEST_PRICING);
    const request = estimateRequestSchema.parse({ files: Array.from({ length: 1_000 }, (_, index) => scan(1 + (index % 300))) });
    quoteEstimate(request, { env: BILLED });
    const runs = 20;
    const started = performance.now();
    for (let i = 0; i < runs; i += 1) quoteEstimate({ ...request, settings: { quality: i % 2 ? "good" : "fast" } }, { env: BILLED });
    const perQuote = (performance.now() - started) / runs;
    console.log(`[estimate-quote] 1,000 profiled files: ${perQuote.toFixed(2)} ms per quote`);
    expect(perQuote).toBeLessThan(150);
  });
});
