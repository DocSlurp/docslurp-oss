import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Document, ProjectRun } from "../models.js";
import { defaultPipelineFeatures, normalizePipelineFeatures, pageCredits } from "@docslurp/shared";

const reads = vi.hoisted(() => [] as unknown[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => {
      reads.push(args[0]);
      return actual.readFile(...args);
    }),
  };
});

import { MAX_COUNTED_PAGES, csvCellText, extraCreditsForMeasuredPages, measureExtractedPages, recordMeasuredPageCount, sheetCellTexts } from "../lib/office-page-count.js";
import { WorkflowState } from "../pipeline/pipeline.js";
import { ToCanonicalStage } from "../stages/to-canonical.js";
import type { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";

function document(filename: string, mimeType: string, pageCount = 1): Document {
  return { id: "doc-1", userId: "u", runId: "run-1", filename, mimeType, sourceKey: `u/run/raw/${filename}`, status: "queued", extractionMode: "hybrid", pageCount, createdAt: new Date(), updatedAt: new Date() };
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** `pages` pages of Markdown by the 3,500-character rule, paragraphs separated by blank lines as Pandoc writes them. */
function markdownOfPages(pages: number): string {
  return Array.from({ length: pages * 5 }, (_, index) => `Paragraph ${index}: ${"the supplier shall deliver the goods. ".repeat(18)}`.trim()).join("\n\n");
}

/** A GFM sheet the way office_markdown.py writes it. */
function sheet(name: string, rows: string[][]): string {
  const width = Math.max(...rows.map((row) => row.length));
  const pad = (row: string[]) => [...row, ...Array(width - row.length).fill("")];
  return [`## ${name}`, "", `| ${pad(rows[0]!).join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`, ...rows.slice(1).map((row) => `| ${pad(row).join(" | ")} |`)].join("\n");
}

describe("measureExtractedPages: counts from the extractor's own output", () => {
  it("counts a 300-page DOCX's Markdown by the text rule, never as one page", () => {
    const counted = measureExtractedPages("office-word", "pandoc", markdownOfPages(300));
    expect(counted?.method).toBe("text-rule");
    expect(counted!.pages).toBeGreaterThanOrEqual(300);
    expect(counted!.pages).toBeLessThanOrEqual(302);
  });

  it("does not bill blank lines between paragraphs as lines of reading", () => {
    // 600 one-word paragraphs: 1,199 lines with the blank ones, 600 that hold something (10 pages by the 60-line rule, not 20).
    const markdown = Array.from({ length: 600 }, (_, index) => `word${index}`).join("\n\n");
    expect(measureExtractedPages("office-word", "pandoc", markdown)).toEqual({ pages: 10, method: "text-rule" });
  });

  it("strips HTML markup a Markdown writer leaves (a complex table) before counting: attributes do not bill", () => {
    const table = (attributes: string) =>
      `<table>${Array.from({ length: 50 }, (_, index) => `<tr><td${attributes}>cell ${index}</td></tr>`).join("")}</table>`;
    const plain = measureExtractedPages("office-word", "pandoc", table(""));
    const styled = measureExtractedPages("office-word", "pandoc", table(` style="${"border:1px solid #000;padding:4px;".repeat(20)}"`));
    expect(styled).toEqual(plain);
    expect(plain).toEqual({ pages: 1, method: "text-rule" });
  });

  it("counts ODT, RTF and EPUB Markdown by the same text rule", () => {
    for (const format of ["office-other", "epub"]) {
      expect(measureExtractedPages(format, "pandoc", markdownOfPages(40))).toMatchObject({ method: "text-rule", pages: 40 });
    }
  });

  it("counts a PPTX's slides from the python-pptx extractor's form-feed pages, a slide a page however little it holds", () => {
    const deck = Array.from({ length: 48 }, (_, index) => `## Slide ${index + 1}`).join("\n\f\n");
    expect(measureExtractedPages("office-pptx", "pptx", `${deck}\n`)).toEqual({ pages: 48, method: "slides" });
    expect(measureExtractedPages("office-pptx", "pptx", "## Title only\n")).toEqual({ pages: 1, method: "slides" });
  });

  it("bills a slide's text, not one page: a single slide holding a book counts as the text rule's pages", () => {
    // About 1,000 pages of prose on one slide (Council C M2): once one page, now the text rule's count.
    const book = markdownOfPages(1_000);
    const one = measureExtractedPages("office-pptx", "pptx", `## Slide 1\n${book}\n`)!;
    expect(one.method).toBe("slides");
    expect(one.pages).toBeGreaterThanOrEqual(1_000);
    // Per slide: two near-empty slides and one full of text sum to 1 + 1 + its pages.
    const mixed = measureExtractedPages("office-pptx", "pptx", `## A\n\f\n## B\n\f\n## C\n${markdownOfPages(30)}\n`)!;
    expect(mixed.pages).toBeGreaterThanOrEqual(32);
  });

  it("counts a PPTX another extractor read by the text rule: only python-pptx's form feeds mark slides", () => {
    expect(measureExtractedPages("office-pptx", "pandoc", "a\fb\fc")).toMatchObject({ method: "text-rule" });
  });

  it("counts a spreadsheet's sheets by the text their cells hold, summed per sheet", () => {
    const rows = Array.from({ length: 600 }, (_, index) => [`row ${index}`, String(index * 3), "note"]);
    const book = [sheet("Orders", [["Item", "Qty", "Note"], ...rows]), sheet("Tiny", [["a"]])].join("\n\n");
    // 601 lines on the first sheet (11 pages by the 60-line rule) and one on the second (1 page).
    expect(measureExtractedPages("office-excel", "xlsx", book)).toEqual({ pages: 12, method: "sheet-rows" });
  });

  it("does not read separator rows, empty cells or a row of empty cells as text", () => {
    const book = sheet("Sparse", [["a", "", "", "", "b"], ["", "", "", "", ""], ["", "", "c"]]);
    expect(sheetCellTexts(book)).toEqual(["a b\nc"]);
  });

  it("unescapes cells and keeps a cell's line breaks as lines, like the CSV rule", () => {
    const book = sheet("Esc", [["pipe \\| inside", "two<br>lines"]]);
    expect(sheetCellTexts(book)).toEqual(["pipe | inside two\nlines"]);
    expect(csvCellText('"pipe | inside","two\nlines"')).toBe("pipe | inside two\nlines");
  });

  it("does not bill the formula and source-context appendix as sheet text", () => {
    const appendix = "\n\n## Spreadsheet formula source\n\nFormulas are source expressions. Cached values were stored by the workbook author; they have not been recalculated.\n\n| Sheet | Cell | Formula | Cached value | XLSX value type |\n| --- | --- | --- | --- | --- |\n" +
      Array.from({ length: 5_000 }, (_, index) => `| S | A${index} | =B${index}*2 | ${index} | n |`).join("\n");
    expect(measureExtractedPages("office-excel", "xlsx", `${sheet("S", [["x"]])}${appendix}`)).toEqual({ pages: 1, method: "sheet-rows" });
  });

  it("cannot be cut short by a sheet named like the appendix heading (it bills every sheet after it)", () => {
    const rows = Array.from({ length: 1_200 }, (_, index) => [`value ${index}`, String(index)]);
    const book = [sheet("Spreadsheet formula source", [["a"]]), sheet("Office source context", [["b"]]), sheet("Data", [["k", "v"], ...rows])].join("\n\n");
    expect(measureExtractedPages("office-excel", "xlsx", book)!.pages).toBeGreaterThanOrEqual(21);
  });

  it("measures empty output as 0 pages, and does not touch formats measured elsewhere", () => {
    expect(measureExtractedPages("office-word", "pandoc", " \n\n ")).toEqual({ pages: 0, method: "empty" });
    // Separator-only output (an empty sheet's commas) is no text either.
    expect(measureExtractedPages("office-excel", "pandoc", ",,,\n,,\n")).toEqual({ pages: 0, method: "empty" });
    expect(measureExtractedPages("pdf", "poppler-text", markdownOfPages(5))).toBeNull();
    expect(measureExtractedPages("image", "ocr", markdownOfPages(5))).toBeNull();
  });

  it("caps a runaway count at the ceiling", () => {
    const deck = Array.from({ length: MAX_COUNTED_PAGES + 50 }, () => "x").join("\f");
    expect(measureExtractedPages("office-pptx", "pptx", deck)).toEqual({ pages: MAX_COUNTED_PAGES, method: "slides" });
  });
});

describe("recordMeasuredPageCount", () => {
  it("records a 300-page DOCX's count as billing pages and leaves the page basis at the text's one page", async () => {
    const doc = document("contract.docx", DOCX);
    const setDocumentBillingPages = vi.fn(async () => true);
    const result = await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentBillingPages } }, doc, "office-word", { extractor: "pandoc", markdown: markdownOfPages(300) });
    expect(result.method).toBe("text-rule");
    expect(result.pages).toBeGreaterThanOrEqual(300);
    expect(setDocumentBillingPages).toHaveBeenCalledWith("run-1", "doc-1", result.pages, "text-rule");
    expect(doc.billingPages).toBe(result.pages);
    expect(doc.pageCount).toBe(1); // the page basis: the extractor's text has no form feeds, so a 300-page basis would drop every page
  });

  it("records a count passed through unchanged (a deduplicated copy reuses its original's)", async () => {
    const doc = document("deck.pptx", PPTX);
    const setDocumentBillingPages = vi.fn(async () => true);
    expect(await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentBillingPages } }, doc, "office-pptx", { pages: 40, method: "slides" }))
      .toEqual({ pages: 40, method: "slides", intakePages: 1 });
    expect(setDocumentBillingPages).toHaveBeenCalledWith("run-1", "doc-1", 40, "slides");
  });

  it("records an empty extraction as 0 measured pages, and nothing for formats measured elsewhere", async () => {
    const setDocumentBillingPages = vi.fn(async () => true);
    const state = { run: { id: "run-1" }, store: { setDocumentBillingPages } };
    expect(await recordMeasuredPageCount(state, document("empty.odt", "application/vnd.oasis.opendocument.text"), "office-other", { extractor: "pandoc", markdown: "" }))
      .toEqual({ pages: 0, method: "empty", intakePages: 1 });
    expect(setDocumentBillingPages).toHaveBeenCalledExactlyOnceWith("run-1", "doc-1", 0, "empty");
    setDocumentBillingPages.mockClear();
    expect(await recordMeasuredPageCount(state, document("a.pdf", "application/pdf", 12), "pdf", { extractor: "poppler-text", markdown: markdownOfPages(3) }))
      .toMatchObject({ pages: null });
    expect(await recordMeasuredPageCount(state, document("b.docx", DOCX), "office-word", null)).toMatchObject({ pages: null });
    expect(setDocumentBillingPages).not.toHaveBeenCalled();
  });

  it("prices a measured sheet's extra pages and features", () => {
    const pipeline = normalizePipelineFeatures({ ...defaultPipelineFeatures, summarize: false });
    expect(extraCreditsForMeasuredPages(pipeline, 1, 12, "sheet-rows", { features: false })).toBeCloseTo(pageCredits("fast", 11));
  });
});

/**
 * Council B: counting must not run a parser on the worker host. With DOCSLURP_SERVICE_PROFILE unset and no opt-in, a DOCX, RTF,
 * EPUB or PPTX goes through to-canonical and its page count without any parser running (no runner.run, no download of the
 * source for counting, no in-process read of its bytes).
 */
describe("no host parser runs to count Office, RTF, EPUB or PPTX pages", () => {
  const cases = [
    { name: "DOCX (was Mammoth)", filename: "contract.docx", mimeType: DOCX, format: "office-word", extractor: "pandoc" },
    { name: "RTF (was unrtf)", filename: "memo.rtf", mimeType: "application/rtf", format: "office-other", extractor: "pandoc" },
    { name: "EPUB (was the ebooklib sidecar)", filename: "book.epub", mimeType: "application/epub+zip", format: "epub", extractor: "pandoc" },
    { name: "PPTX (was an in-process ZIP read)", filename: "deck.pptx", mimeType: PPTX, format: "office-pptx", extractor: "pptx" },
    { name: "XLSX", filename: "book.xlsx", mimeType: XLSX, format: "office-excel", extractor: "xlsx" },
  ];

  function spyRunner() {
    const calls: string[] = [];
    const runner = new Proxy({}, {
      get: (_target, property) => {
        const name = String(property);
        if (name === "then") return undefined;
        return vi.fn(async (...args: unknown[]) => {
          calls.push(name);
          if (name === "run") throw new Error(`a parser ran: ${JSON.stringify(args[0])}`);
          return { binary: name, args: [], available: true };
        });
      },
    }) as unknown as CommandRunner;
    return { runner, calls };
  }

  function spyStorage() {
    const downloads = vi.fn(async () => { throw new Error("the source was downloaded to count pages"); });
    const storage = {
      bucket: "test",
      putJson: vi.fn(async () => undefined),
      uri: (key: string) => `s3://test/${key}`,
      downloadSourceToTempFile: downloads,
      downloadToTempFile: downloads,
      getBytes: downloads,
    } as unknown as ArtifactStore;
    return { storage, downloads };
  }

  function run(): ProjectRun {
    return {
      id: "run-1", orgId: "org-1", userId: "u", kind: "bulk-upload", status: "processing", stage: "to-canonical", totalDocuments: 1,
      processedDocuments: 0, pagesTotal: 1, pagesProcessed: 0, spentCents: 0, pipeline: { ...defaultPipelineFeatures }, error: null,
      stats: {}, artifacts: {}, claimId: null, createdAt: new Date(), updatedAt: new Date(),
    } as ProjectRun;
  }

  for (const entry of cases) {
    it(`${entry.name}: to-canonical plans only, and the count reads the extractor's Markdown`, async () => {
      vi.stubEnv("DOCSLURP_SERVICE_PROFILE", "");
      reads.length = 0;
      const { runner, calls } = spyRunner();
      const { storage, downloads } = spyStorage();
      const doc = document(entry.filename, entry.mimeType);
      const state = WorkflowState.create(run(), [doc]);
      state.artifactLedger.recordDocument(doc.id, "normalizedFormat", entry.format);
      await new ToCanonicalStage(runner, storage).run(state);

      expect(state.documentStage(doc.id, "to-canonical")).toMatchObject({ status: "completed" });
      // to-canonical records command plans (as it did before counting existed); a plan only describes a command. Nothing runs.
      expect(calls).not.toContain("run");
      expect(downloads).not.toHaveBeenCalled();

      const setDocumentBillingPages = vi.fn(async () => true);
      const markdown = entry.extractor === "pptx" ? ["## One", "## Two", "## Three"].join("\n\f\n") : entry.extractor === "xlsx" ? sheet("S", [["a", "1"], ["b", "2"]]) : markdownOfPages(7);
      const counted = await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentBillingPages } }, doc, entry.format, { extractor: entry.extractor, markdown });
      expect(counted.pages).toBeGreaterThanOrEqual(1);
      expect(reads.filter((target) => String(target).includes(entry.filename))).toEqual([]);
      vi.unstubAllEnvs();
    });
  }

  it("the counting module imports no file system, ZIP reader or command runner", () => {
    const source = readFileSync(path.resolve(import.meta.dirname, "../lib/office-page-count.ts"), "utf8");
    expect(source).not.toMatch(/from "node:fs|listZipEntryNames|CommandRunner|downloadSource/);
  });
});
