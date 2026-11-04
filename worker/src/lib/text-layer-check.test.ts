import { describe, expect, it, vi } from "vitest";

import { scoreExtractionPlausibility } from "./extracted-markdown.js";
import { createTextLayerVerifier, tesseractLanguageForText } from "./text-layer-check.js";
import { verifySuspectPages } from "./page-image-evidence.js";

const prose = "The committee reviewed the quarterly report and agreed that the new schedule should begin after the winter break, provided that every department confirms its staffing plans.";

describe("scoreExtractionPlausibility uses the text-layer detector", () => {
  const shift = (text: string) => [...text].map((c) => (c > " " && c < "\x7f" ? String.fromCharCode(33 + ((c.charCodeAt(0) - 33 + 29) % 94)) : c)).join("");

  it("scores broken text low and a short real page high", () => {
    const real = scoreExtractionPlausibility(Array.from({ length: 6 }, () => prose).join(" "), 1).plausibilityScore;
    const cid = scoreExtractionPlausibility(Array.from({ length: 40 }, (_, i) => `(cid:${72 + (i % 9)})(cid:101)(cid:108)(cid:108)(cid:111)`).join(" "), 1).plausibilityScore;
    const mojibake = scoreExtractionPlausibility(Buffer.from("Привет мир, это страница с обычным русским текстом для проверки. ".repeat(8), "utf8").toString("latin1"), 1).plausibilityScore;
    const shifted = scoreExtractionPlausibility(shift(Array.from({ length: 6 }, () => prose).join(" ")), 1).plausibilityScore;
    const invoice = scoreExtractionPlausibility("Invoice 1042\nBilled to Acme Ltd\nTotal due: 120.00 EUR\nPay within 30 days", 1).plausibilityScore;
    expect(real).toBeGreaterThan(0.9);
    for (const broken of [cid, mojibake, shifted]) expect(broken).toBeLessThan(0.3);
    // The old yield-based score put a short invoice near 0.5 and (cid:N) near 0.9.
    expect(invoice).toBeGreaterThanOrEqual(0.8);
    expect(scoreExtractionPlausibility("", 1).plausibilityScore).toBe(0);
  });

  it("reads a CJK page by its characters, not by whitespace", () => {
    const cjk = scoreExtractionPlausibility("委员会审议了季度报告，并同意在冬季休假之后开始执行新的时间表，前提是每个部门都确认其人员安排。".repeat(6), 1);
    expect(cjk.plausibilityScore).toBeGreaterThan(0.8);
    expect(cjk.wordCount).toBeGreaterThan(30);
  });
});

describe("OCR cross-check of suspect text layers", () => {
  it("picks a Tesseract language from the layer's script", () => {
    expect(tesseractLanguageForText(prose)).toBe("eng");
    expect(tesseractLanguageForText("Комитет рассмотрел квартальный отчёт и решил продолжить")).toBe("rus+ukr");
    expect(tesseractLanguageForText("Η επιτροπή εξέτασε την τριμηνιαία έκθεση")).toBe("ell");
    expect(tesseractLanguageForText("委员会审议了季度报告并同意执行新的时间表")).toBe("chi_sim+chi_tra");
    expect(tesseractLanguageForText("委員会は四半期報告書を検討し、すべての部門が確認した。")).toBe("jpn+chi_sim");
    expect(tesseractLanguageForText("1234 5678")).toBeNull();
  });

  const pages = (numbers: number[]) => numbers.map((pageNumber) => ({ pageNumber, text: prose }));

  it("checks a spread sample and gives the rest the sample's unanimous verdict", async () => {
    const checked: number[][] = [];
    const verify = vi.fn(async (sample: Array<{ pageNumber: number }>) => {
      checked.push(sample.map((page) => page.pageNumber));
      return new Map(sample.map((page) => [page.pageNumber, false as boolean | null]));
    });
    const verdicts = await verifySuspectPages(pages(Array.from({ length: 30 }, (_, i) => i + 1)), verify);
    expect(checked[0]).toHaveLength(6);
    expect(verdicts.size).toBe(30);
    expect([...verdicts.values()].every((value) => value === false)).toBe(true);
  });

  it("leaves unchecked pages unknown when the sample disagrees or could not run", async () => {
    const mixed = async (sample: Array<{ pageNumber: number }>) => new Map(sample.map((page, index) => [page.pageNumber, index % 2 === 0] as const));
    const verdicts = await verifySuspectPages(pages([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), mixed);
    const unchecked = [...verdicts].filter(([page]) => ![1, 2, 4, 6, 7, 9].includes(page));
    expect(unchecked.every(([, value]) => value === null)).toBe(true);
    const none = await verifySuspectPages(pages([1, 2, 3, 4]), async () => new Map());
    expect([...none.values()].every((value) => value === null)).toBe(true);
  });

  it("an OCR that agrees marks the layer a match, one that does not marks it a mismatch, a failure is unchecked", async () => {
    const png = Buffer.from("not really a png");
    const runner = {
      renderPdfPageRange: async (_s: string, prefix: string) => ({ binary: "pdftoppm", args: [prefix], available: true }),
      plan: async () => ({ binary: "tesseract", args: [], available: true }),
      run: async (plan: { binary: string; args: string[] }) => {
        const { writeFile } = await import("node:fs/promises");
        if (plan.binary === "pdftoppm") await writeFile(`${plan.args[0]}-1.png`, png);
        return { stdout: "", stderr: "" };
      },
    };
    const verifier = (text: string | null | Error) => createTextLayerVerifier({
      runner: runner as never,
      sourcePath: "/doc.pdf",
      recogniser: () => async () => { if (text instanceof Error) throw text; return text; },
    });
    const layer = [{ pageNumber: 1, text: prose }];
    expect((await verifier(prose)(layer)).get(1)).toBe(true);
    expect((await verifier("Completely different words about something else entirely, nothing in common with the layer text here at all today")(layer)).get(1)).toBe(false);
    expect((await verifier(null)(layer)).get(1)).toBeNull();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await verifier(new Error("no language data"))(layer)).get(1)).toBeNull();
  });
});
