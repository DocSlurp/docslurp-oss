import { describe, expect, it } from "vitest";
import type { CanonicalBlock } from "@docslurp/shared";

import { buildEvidenceIndex, locateEvidence } from "../lib/evidence-locator.js";
import { mergeFieldAnswers, pickField, planStructuredWindows } from "../lib/structured-windows.js";

const block = (id: string, text: string, pageNumber: number | null = 1): CanonicalBlock =>
  ({ id, type: "paragraph", order: 0, text, headingPath: [], pageNumber, lineStart: 1, lineEnd: 1, bbox: null, metadata: {} }) as CanonicalBlock;

describe("locateEvidence", () => {
  const blocks = [
    block("a", "The supplier shall deliver the goods\nwithin thirty (30)   days of the order.", 1),
    block("b", "Late delivery incurs a penalty of 2% per week.", 1),
    block("c", "Payment is due 請求日 から 30日以内。", 2),
  ];
  const index = buildEvidenceIndex(blocks);

  it("ignores line breaks and runs of whitespace", () => {
    expect(locateEvidence(index, "deliver the goods within thirty (30) days")?.map((b) => b.id)).toEqual(["a"]);
  });

  it("matches a quotation that spans blocks, even across a page", () => {
    expect(locateEvidence(index, "of the order. Late delivery incurs a penalty")?.map((b) => b.id)).toEqual(["a", "b"]);
    expect(locateEvidence(index, "per week. Payment is due 請求日")?.map((b) => b.id)).toEqual(["b", "c"]);
  });

  it("compares case, composition and non-Latin text", () => {
    expect(locateEvidence(index, "LATE DELIVERY INCURS")?.map((b) => b.id)).toEqual(["b"]);
    expect(locateEvidence(index, "請求日 から 30日以内")?.map((b) => b.id)).toEqual(["c"]);
    expect(locateEvidence(buildEvidenceIndex([block("m", "München office")]), "München office")?.map((b) => b.id)).toEqual(["m"]);
  });

  it("matches the verbatim pieces of an elided quotation and reports no match for invented text", () => {
    expect(locateEvidence(index, "The supplier shall deliver ... of the order.")?.map((b) => b.id)).toEqual(["a"]);
    expect(locateEvidence(index, "The supplier shall deliver the goods in ninety days")).toBeNull();
    expect(locateEvidence(index, "   ")).toBeNull();
  });
});

describe("mergeFieldAnswers", () => {
  it("keeps the most confident non-null scalar and never lets a null override", () => {
    expect(mergeFieldAnswers([{ value: null, confidence: 0.9 }, { value: 5, confidence: 0.4 }, { value: 7, confidence: 0.8 }]).value).toBe(7);
    expect(mergeFieldAnswers([{ value: null }, { value: null }]).value).toBeNull();
  });

  it("unions lists across windows", () => {
    expect(mergeFieldAnswers([{ value: ["a", "b"] }, { value: ["b", "c"] }, { value: [] }]).value).toEqual(["a", "b", "c"]);
  });
});

describe("pickField", () => {
  it("matches keys exactly and never through an ASCII-only normalizer", () => {
    const fields = { 請求日: "a", 支払期限: "b" };
    expect(pickField(fields, "請求日")).toBe("a");
    expect(pickField(fields, "支払期限")).toBe("b");
    expect(pickField({ 請求日: "a" }, "支払期限", ["請求日", "支払期限"])).toBeUndefined();
  });
});

describe("planStructuredWindows", () => {
  it("keeps whole pages together and reports the pages read", () => {
    const pages = Array.from({ length: 10 }, (_, index) => `page ${index + 1} ` + "x".repeat(900));
    const plan = planStructuredWindows({ markdown: pages.join("\f"), pageCount: 10, windowChars: 2_000, maxWindows: 3 });
    expect(plan.windows.map((window) => window.pages)).toEqual([[1, 2], [3, 4], [5, 6]]);
    expect(plan).toMatchObject({ truncated: true, pagesRead: 6, pagesTotal: 10 });
  });

  it("reads everything when it fits", () => {
    const plan = planStructuredWindows({ markdown: "one\ftwo", pageCount: 2, windowChars: 100, maxWindows: 3 });
    expect(plan).toMatchObject({ truncated: false, pagesRead: 2, windows: [{ pages: [1, 2] }] });
  });

  it("does not invent pages when the form feeds do not match the page count", () => {
    const text = "Sentence number one is here. ".repeat(100);
    const plan = planStructuredWindows({ markdown: text, pageCount: 40, windowChars: 500, maxWindows: 2 });
    expect(plan.windows.every((window) => window.pages.length === 0)).toBe(true);
    expect(plan.truncated).toBe(true);
    expect(plan.pagesRead).toBeLessThan(40);
    expect(plan.windows.every((window) => window.text.length <= 500)).toBe(true);
  });
});
