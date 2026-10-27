import { describe, expect, it } from "vitest";
import { selectSummaryInput, SUMMARY_INPUT_MAX_BYTES } from "../stages/summary-input.js";

describe("summary input selection", () => {
  it("collapses repeated catalog rows without erasing changed prices or product codes", () => {
    const row = "Product ABC-123 | Industrial replacement cartridge | Price $100";
    const changed = "Product ABC-124 | Industrial replacement cartridge | Price $101";
    const result = selectSummaryInput(`${row}\n`.repeat(10_000) + changed);
    expect(result.text.split(row)).toHaveLength(2);
    expect(result.text).toContain(changed);
    expect(result.text.length).toBeLessThan(200);
  });

  it("preserves short documents exactly, including empty text", () => {
    for (const text of ["", "# Purpose\n\nA short document.", "x".repeat(SUMMARY_INPUT_MAX_BYTES)]) {
      expect(selectSummaryInput(text)).toEqual({ text, sampled: false });
    }
  });

  it("bounds long input while retaining the outline and evidence across the document", () => {
    const text = Array.from({ length: 100 }, (_, index) =>
      `# Section ${index}\n\n${`Subject ${index}. `.repeat(500)}\n\n`).join("");
    const result = selectSummaryInput(text);
    expect(result.sampled).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(SUMMARY_INPUT_MAX_BYTES);
    expect(result.text).toContain("# Section 0");
    expect(result.text).toContain("# Section 99");
    expect(result.text).toContain("Subject 0.");
    expect(result.text).toContain("Subject 99.");
    expect(result.text).toMatch(/Subject (3\d|6\d)\./);
    expect(selectSummaryInput(text)).toEqual(result);
  });

  it("handles long unstructured and Unicode text without requiring headings", () => {
    const text = "起点" + "内容".repeat(100_000) + "終点";
    const result = selectSummaryInput(text);
    expect(result.sampled).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(SUMMARY_INPUT_MAX_BYTES);
    expect(result.text).toContain("起点");
    expect(result.text).toContain("終点");
  });
});
