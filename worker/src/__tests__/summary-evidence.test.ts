import { describe, expect, it } from "vitest";
import { buildSummaryEvidence, selectSummaryPages, SUMMARY_INPUT_MAX_BYTES, SUMMARY_EVIDENCE_MAX_BYTES } from "../stages/summary-evidence.js";
const build = (text: string, pageCount: number) => buildSummaryEvidence({ text, pageCount, documentId: "doc", sourceUri: "s3://b/text.md" });

describe("page-aware summary evidence", () => {
  it("retains all text and true page positions for short one/two-page documents", () => {
    const result = build("First page details.\fSecond page details.\f", 2);
    expect(result.sampled).toBe(false);
    expect(result.pageReferences).toBe("verified");
    expect(result.text).toContain("First page details.");
    expect(result.text).toContain("Second page details.");
    expect(result.pages.map((p) => p.pageNumber)).toEqual([1, 2]);
  });
  it("retains opening pages and spreads ten stable samples across 100,000 pages", () => {
    const result = build(Array.from({ length: 100_000 }, (_, i) => `Page content ${i + 1}\n`).join("\f"), 100_000);
    expect(result.pages).toHaveLength(10);
    expect(result.pages.slice(0, 3).map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(result.pages.at(-1)?.pageNumber).toBe(100_000);
    expect(result.sampled).toBe(true);
    expect(result.pages.map((p) => p.pageNumber)).toEqual(selectSummaryPages(100_000, "doc").map((p) => p + 1));
    expect(selectSummaryPages(100_000, "other")).not.toEqual(selectSummaryPages(100_000, "doc"));
  });
  it("bounds dense Unicode pages and JSON escaping, marking clipped data", () => {
    for (const row of ["内容🧪".repeat(40_000), '\\"\t'.repeat(40_000)]) {
      const result = build(Array.from({ length: 12 }, () => row).join("\f"), 12);
      expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(SUMMARY_INPUT_MAX_BYTES);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(SUMMARY_EVIDENCE_MAX_BYTES);
      expect(result.sampled).toBe(true);
      expect(result.text).not.toContain("�");
    }
  });
  it("deduplicates dense rows without erasing changed product codes or prices", () => {
    const row = "Product ABC-123 | Industrial replacement cartridge | Price $100";
    const changed = "Product ABC-124 | Industrial replacement cartridge | Price $101";
    const result = build(`${row}\n`.repeat(40) + changed, 1);
    expect(result.text.split(row)).toHaveLength(2);
    expect(result.text).toContain(changed);
  });
  it("does not invent page references when extracted boundaries disagree", () => {
    const result = build("No trustworthy page boundaries. ".repeat(10_000), 5000);
    expect(result.pageReferences).toBe("unavailable");
    expect(result.pages).toEqual([]);
    expect(result.sampled).toBe(true);
    expect(result.text).toContain("page unknown");
  });
  it("retains the end of Unicode documents without verified page boundaries", () => {
    const result = build("内容🧪".repeat(10_000) + "Final marker", 5000);
    expect(result.text).toContain("Final marker");
    expect(result.text).not.toContain("�");
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(SUMMARY_INPUT_MAX_BYTES);
  });
});
