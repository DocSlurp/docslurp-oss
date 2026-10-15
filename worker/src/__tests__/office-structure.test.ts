import { describe, expect, it } from "vitest";
import { buildCanonicalChunksFromDocument, buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { csvRecords, enrichCanonicalDocumentWithPptx, enrichCanonicalDocumentWithXlsx } from "../lib/office-structure.js";

// Shapes of the python-pptx / openpyxl sidecars (captured from scripts/pptx_extract.py and scripts/xlsx_extract.py).
const deck = { slideCount: 3, slides: [
  { index: 1, title: "Quarterly Roadmap", notes: "", shapes: [
    { text: "Quarterly Roadmap", box: { x: 0.075, y: 0.3106, width: 0.85, height: 0.2144 } },
    { text: "Platform team review", box: { x: 0.15, y: 0.5667, width: 0.7, height: 0.2556 } }] },
  { index: 2, title: "Cost per thousand pages", notes: "Mention that the native parser drove most of the saving.", shapes: [
    { text: "Cost per thousand pages", box: { x: 0.05, y: 0.04, width: 0.9, height: 0.1667 } },
    { text: "Spend dropped eighteen percent", box: { x: 0.05, y: 0.2333, width: 0.9, height: 0.66 } },
    { text: "Source: finance dashboard", box: { x: 0.1, y: 0.6667, width: 0.4, height: 0.1333 } }] },
  { index: 3, title: "Risks", notes: "", shapes: [{ text: "Risks", box: { x: 0.05, y: 0.04, width: 0.9, height: 0.1667 } }] },
] };
const deckMarkdown = "## Quarterly Roadmap\n\nPlatform team review\n\n## Cost per thousand pages\n\nSpend dropped eighteen percent\n\nSource: finance dashboard\n\n## Risks";

describe("slide locators", () => {
  const doc = enrichCanonicalDocumentWithPptx(buildCanonicalDocumentFromMarkdown({ documentId: "p", text: deckMarkdown, pageCount: 1, extractor: "kreuzberg" }), deck);
  const chunks = buildCanonicalChunksFromDocument(doc, "deck.pptx", { maxChars: 4000 });
  it("assigns each block to its slide with the matching shape box", () => {
    const spend = doc.blocks.find(b => b.text.startsWith("Spend"))!;
    expect(spend.metadata.slide).toMatchObject({ number: 2, count: 3, title: "Cost per thousand pages", notes: false, box: { x: 0.05, y: 0.2333, width: 0.9, height: 0.66 } });
  });
  it("indexes speaker notes as their own block after the slide", () => {
    const notes = doc.blocks.find(b => b.text.startsWith("Mention"))!;
    expect(notes.metadata.slide).toMatchObject({ number: 2, notes: true });
    expect(doc.blocks.indexOf(notes)).toBeGreaterThan(doc.blocks.findIndex(b => b.text.startsWith("Source:")));
    expect(new Set(doc.blocks.map(b => b.id)).size).toBe(doc.blocks.length);
  });
  it("never merges slides or notes into one chunk and emits slide locators", () => {
    expect(chunks.map(c => c.locator)).toEqual([
      expect.objectContaining({ kind: "slide", slideNumber: 1, slideCount: 3, notes: false, title: "Quarterly Roadmap" }),
      expect.objectContaining({ kind: "slide", slideNumber: 2, notes: false }),
      expect.objectContaining({ kind: "slide", slideNumber: 2, notes: true }),
      expect.objectContaining({ kind: "slide", slideNumber: 3 }),
    ]);
    expect(chunks[1].locator).toMatchObject({ boxes: expect.arrayContaining([{ x: 0.05, y: 0.2333, width: 0.9, height: 0.66 }]) });
  });
  it("does not pin short or unmatched blocks to the wrong slide", () => {
    const tiny = { slideCount: 2, slides: [
      { index: 1, title: "Plan", notes: "", shapes: [{ text: "Plan", box: null }, { text: "Costs\nQ3\nHeadcount grows next year", box: { x: 0.1, y: 0.2, width: 0.8, height: 0.5 } }] },
      { index: 2, title: "Q3 review", notes: "", shapes: [{ text: "Q3 review", box: null }, { text: "Q3 targets met across regions", box: null }] },
    ] };
    const md3 = "## Plan\n\nCosts\n\nQ3\n\nHeadcount grows next year\n\n## Unmatched heading\n\nQ3 targets met across regions";
    const out = enrichCanonicalDocumentWithPptx(buildCanonicalDocumentFromMarkdown({ documentId: "s", text: md3, pageCount: 1, extractor: "k" }), tiny);
    const slideOf = (text: string) => (out.blocks.find(b => b.text.replace(/^#+ /, "").startsWith(text))!.metadata.slide as { number: number } | undefined)?.number;
    expect(slideOf("Q3")).toBe(1); // one line of a multi-line shape on the current slide, not slide 2's "Q3 review"
    expect(slideOf("Unmatched heading")).toBe(2); // opens the next slide; never attributed to the previous one
    expect(slideOf("Q3 targets")).toBe(2);
  });
  it("leaves a document alone when nothing matches", () => {
    const other = buildCanonicalDocumentFromMarkdown({ documentId: "o", text: "Totally unrelated words", pageCount: 1, extractor: "x" });
    expect(enrichCanonicalDocumentWithPptx(other, deck)).toBe(other);
  });
});

describe("sheet locators", () => {
  const book = { sheets: [
    { name: "Timeline", csv: ",,,\n,,,\n,Milestone,Owner,Due\n,Design review,Ana,2026-10-20\n,Security review,Bo,2026-10-27\n,Launch,Cy,2026-10-30\n", firstRow: 3, firstCol: 2, lastRow: 6, lastCol: 4, headerRow: 3, dataRows: [4, 5, 6] },
    { name: "Budget", csv: "Item,Cost\nParser,1200\nASR,300\n", firstRow: 1, firstCol: 1, lastRow: 3, lastCol: 2, headerRow: 1, dataRows: [2, 3] },
  ] };
  const md = "## Timeline\n\n| Milestone | Owner | Due |\n| --- | --- | --- |\n| Design review | Ana | 2026-10-20 |\n| Security review | Bo | 2026-10-27 |\n| Launch | Cy | 2026-10-30 |\n\n## Budget\n\n| Item | Cost |\n| --- | --- |\n| Parser | 1200 |\n| ASR | 300 |";
  const doc = enrichCanonicalDocumentWithXlsx(buildCanonicalDocumentFromMarkdown({ documentId: "x", text: md, pageCount: 1, extractor: "kreuzberg" }), book);
  const chunks = buildCanonicalChunksFromDocument(doc, "book.xlsx", { maxChars: 4000 });
  const sheet = (predicate: (c: (typeof chunks)[number]) => boolean) => chunks.find(predicate)?.locator;
  it("gives the whole table, each row and each cell an absolute A1 range with the header row", () => {
    expect(sheet(c => c.tableGranularity === "table" && c.text.includes("Milestone"))).toEqual({ kind: "sheet", sheetName: "Timeline", range: "B3:D6", headerRow: 3 });
    expect(sheet(c => c.tableGranularity === "row" && c.text.includes("Security review"))).toEqual({ kind: "sheet", sheetName: "Timeline", range: "B5:D5", headerRow: 3 });
    expect(sheet(c => c.tableGranularity === "cell" && c.text.includes("Owner: Cy"))).toEqual({ kind: "sheet", sheetName: "Timeline", range: "C6", headerRow: 3 });
    expect(sheet(c => c.tableGranularity === "cell" && c.text.includes("Cost: 300"))).toEqual({ kind: "sheet", sheetName: "Budget", range: "B3", headerRow: 1 });
  });
  it("locates only the table (never a guessed row) when the Markdown dropped rows or the sheet has blank rows", () => {
    const short = md.replace("| Security review | Bo | 2026-10-27 |\n", "");
    const partial = enrichCanonicalDocumentWithXlsx(buildCanonicalDocumentFromMarkdown({ documentId: "x", text: short, pageCount: 1, extractor: "k" }), book);
    const row = buildCanonicalChunksFromDocument(partial, "b", { maxChars: 4000 }).find(c => c.tableGranularity === "row" && c.text.includes("Launch"));
    expect(row?.locator).toEqual({ kind: "sheet", sheetName: "Timeline", range: "B3:D6", headerRow: 3 });
  });
  it("does not trust row numbers from a bounded (truncated) scan and survives very tall sheets", () => {
    const truncated = { sheets: [{ ...book.sheets[1], truncated: true }] };
    const budget = enrichCanonicalDocumentWithXlsx(buildCanonicalDocumentFromMarkdown({ documentId: "t", text: md.split("## Budget")[1]!, pageCount: 1, extractor: "k" }), truncated);
    const row = buildCanonicalChunksFromDocument(budget, "b", { maxChars: 4000 }).find(c => c.tableGranularity === "row");
    expect(row?.locator).toMatchObject({ kind: "sheet", range: "A1:B3" });
    const rows = Array.from({ length: 150_000 }, (_, i) => i + 2);
    const tall = { sheets: [{ name: "Tall", csv: "a\n", firstRow: 1, firstCol: 1, lastRow: 150_001, lastCol: 1, headerRow: 1, dataRows: rows }] };
    const md2 = "## Tall\n\n| a |\n| --- |\n" + rows.slice(0, 3).map(() => "| x |").join("\n");
    expect(() => buildCanonicalChunksFromDocument(enrichCanonicalDocumentWithXlsx(buildCanonicalDocumentFromMarkdown({ documentId: "t", text: md2, pageCount: 1, extractor: "k" }), tall), "t")).not.toThrow();
  });
  it("parses quoted CSV records", () => {
    expect(csvRecords('a,"b,c"\n"x\ny",z\n', 5)).toEqual([["a", "b,c"], ["x\ny", "z"]]);
  });
});
