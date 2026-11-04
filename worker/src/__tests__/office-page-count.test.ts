import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Document } from "../models.js";
import { measureDocumentPages, parsePdfInfoPages, recordMeasuredPageCount, type PageCountDeps } from "../lib/office-page-count.js";

function document(filename: string, mimeType: string, pageCount = 1): Document {
  return { id: "doc-1", userId: "u", runId: "run-1", filename, mimeType, sourceKey: `u/run/raw/${filename}`, status: "queued", extractionMode: "hybrid", pageCount, createdAt: new Date(), updatedAt: new Date() };
}

/** A runner whose soffice "converts" by writing a PDF and whose pdfinfo reports `pdfPages`. */
function fakeDeps(options: { pdfPages?: number; sidecar?: unknown; sofficeFails?: boolean; noSoffice?: boolean; bytes?: Buffer; mammothText?: string; catdocText?: string; unrtfHtml?: string }): PageCountDeps {
  const available = (binary: string, ...args: string[]) => ({ binary, args, available: true });
  const unavailable = (binary: string) => ({ binary, args: [], available: false });
  return {
    runner: {
      officeToPdf: async (source: string, outdir: string) => options.noSoffice ? unavailable("soffice") : available("soffice", "--convert-to", "pdf", source, "--outdir", outdir),
      mammothMarkdown: async (source: string, output: string) => options.mammothText === undefined ? unavailable("mammoth") : available("mammoth", source, output),
      docToText: async (source: string) => options.catdocText === undefined ? unavailable("catdoc") : available("catdoc", source),
      rtfToHtml: async (source: string) => options.unrtfHtml === undefined ? unavailable("unrtf") : available("unrtf", source),
      pdfInfo: async (source: string) => available("pdfinfo", source),
      pptxExtract: async (source: string, output: string) => available("pptx", source, output),
      xlsxExtractPy: async (source: string, output: string) => available("xlsx", source, output),
      epubExtract: async (source: string, output: string) => available("epub", source, output),
      run: async (plan: { binary: string; args: string[] }) => {
        if (plan.binary === "soffice") {
          if (options.sofficeFails) throw new Error("soffice crashed");
          const outdir = plan.args[plan.args.indexOf("--outdir") + 1]!;
          const source = plan.args[plan.args.indexOf("pdf") + 1]!;
          await writeFile(path.join(outdir, `${path.basename(source, path.extname(source))}.pdf`), "%PDF-1.4");
          return { stdout: "", stderr: "" };
        }
        if (plan.binary === "catdoc") return { stdout: options.catdocText ?? "", stderr: "" };
        if (plan.binary === "unrtf") return { stdout: options.unrtfHtml ?? "", stderr: "" };
        if (plan.binary === "mammoth") {
          await writeFile(plan.args[1]!, JSON.stringify({ text: options.mammothText ?? "" }));
          return { stdout: "", stderr: "" };
        }
        if (plan.binary === "pdfinfo") return { stdout: `Title: report\nPages:          ${options.pdfPages}\nEncrypted:      no\n`, stderr: "" };
        await writeFile(plan.args[1]!, JSON.stringify(options.sidecar ?? {}));
        return { stdout: "", stderr: "" };
      },
    } as unknown as PageCountDeps["runner"],
    downloadSource: async (target) => {
      const dir = await mkdtemp(path.join(tmpdir(), "page-count-test-"));
      const file = path.join(dir, target.filename);
      await writeFile(file, options.bytes ?? Buffer.from("x"));
      return file;
    },
  };
}

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("recordMeasuredPageCount", () => {
  it("records a 300-page DOCX's real page count as billing pages and leaves the page basis at the text's one page", async () => {
    const doc = document("contract.docx", DOCX);
    const setDocumentBillingPages = vi.fn(async () => true);
    const result = await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentBillingPages } }, fakeDeps({ pdfPages: 300 }), doc, "office-word");
    expect(result).toEqual({ pages: 300, method: "pdf-conversion", intakePages: 1 });
    expect(setDocumentBillingPages).toHaveBeenCalledWith("run-1", "doc-1", 300, "pdf-conversion");
    expect(doc.billingPages).toBe(300);
    expect(doc.pageCount).toBe(1); // the page basis: the extractor's text has no form feeds, so a 300-page basis would drop every page
  });

  it("counts a 300-page DOCX by the text rule when the worker has no LibreOffice (the lean production image), never as one page", async () => {
    const doc = document("contract.docx", DOCX);
    const setDocumentBillingPages = vi.fn(async () => true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // 300 pages of 3,500 characters each, the way mammoth hands the text over.
    const text = Array.from({ length: 300 * 60 }, (_, line) => `Line ${String(line).padStart(5, "0")} ${"clause ".repeat(8)}`.trim()).join("\n\n");
    const result = await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentBillingPages } },
      fakeDeps({ noSoffice: true, mammothText: text }), doc, "office-word");
    expect(result.method).toBe("text-rule");
    expect(result.pages).toBeGreaterThanOrEqual(300);
    expect(setDocumentBillingPages).toHaveBeenCalledWith("run-1", "doc-1", result.pages, "text-rule");
    expect(doc.billingPages).toBe(result.pages);
    expect(warn.mock.calls.flat().join(" ")).toContain("counted by text-rule");
    warn.mockRestore();
  });

  it("falls back to the text rule when LibreOffice crashes, and to the size estimate when no text tool reads the file", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const long = Array.from({ length: 1_200 }, (_, line) => `row ${line}`).join("\n"); // 20 pages by the 60-line rule
    const rtf = await measureDocumentPages(fakeDeps({ sofficeFails: true, unrtfHtml: `<html><body>${long.replace(/\n/g, "<br>\n")}</body></html>` }), document("memo.rtf", "application/rtf"), "office-other");
    expect(rtf).toMatchObject({ method: "text-rule" });
    expect(rtf!.pages).toBeGreaterThanOrEqual(20);
    const doc = await measureDocumentPages(fakeDeps({ noSoffice: true, catdocText: long }), document("memo.doc", "application/msword"), "office-other");
    expect(doc).toEqual({ pages: 20, method: "text-rule" });
    // An ODT with no text tool: 2.4 MB at the format's 24 KB per page.
    const odt = await measureDocumentPages(fakeDeps({ noSoffice: true, bytes: Buffer.alloc(2_400_000) }), document("deck.odt", "application/vnd.oasis.opendocument.text"), "office-other");
    expect(odt).toEqual({ pages: Math.ceil(2_400_000 / (24 * 1024)), method: "size-estimate" });
    warn.mockRestore();
  });

  it("reports nothing measured only when there is nothing to count (an empty file)", async () => {
    const doc = document("empty.odt", "application/vnd.oasis.opendocument.text", 1);
    const setDocumentBillingPages = vi.fn(async () => true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentBillingPages } },
      fakeDeps({ noSoffice: true, bytes: Buffer.alloc(0) }), doc, "office-other");
    expect(result).toEqual({ pages: null, method: null, intakePages: 1 });
    expect(setDocumentBillingPages).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not touch formats the server already counts (PDF, text, images)", async () => {
    const doc = document("a.pdf", "application/pdf", 12);
    const setDocumentBillingPages = vi.fn(async () => true);
    expect(await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentBillingPages } }, fakeDeps({}), doc, "pdf")).toMatchObject({ pages: null });
    expect(setDocumentBillingPages).not.toHaveBeenCalled();
  });
});

describe("measureDocumentPages", () => {
  it("counts a spreadsheet's sheets by the text rule, so a long sheet is many pages", async () => {
    const longSheet = Array.from({ length: 600 }, (_, row) => `r${row},${row}`).join("\n");
    const result = await measureDocumentPages(fakeDeps({ sidecar: { sheets: [{ csv: longSheet }, { csv: "a,b\n1,2" }, { csv: "" }] } }), document("book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "office-excel");
    expect(result).toEqual({ pages: 11, method: "sheet-rows" });
  });

  it("counts a spreadsheet with a stray cell at A100000 as a page, not 1,667: empty rows are not read", async () => {
    // What the old sidecar wrote: a row of commas for each of the 99,999 empty rows above the note.
    const commas = ",".repeat(10);
    const csv = ["a,b,c", ...Array.from({ length: 99_998 }, () => commas), "a note"].join("\n");
    expect(await measureDocumentPages(fakeDeps({ sidecar: { sheets: [{ csv }] } }), document("stray.xlsx", XLSX), "office-excel")).toEqual({ pages: 1, method: "sheet-rows" });
    // The sidecar now writes one blank line for a run of empty rows; both are ignored.
    expect(await measureDocumentPages(fakeDeps({ sidecar: { sheets: [{ csv: "a,b,c\r\n\r\na note\r\n" }] } }), document("stray.xlsx", XLSX), "office-excel")).toEqual({ pages: 1, method: "sheet-rows" });
  });

  it("counts an EPUB by the text rule over its chapters", async () => {
    const chapter = "word ".repeat(2_000); // 10,000 characters → 3 pages
    const result = await measureDocumentPages(fakeDeps({ sidecar: { chapters: [{ text: chapter }, { text: chapter }] } }), document("book.epub", "application/epub+zip"), "epub");
    expect(result).toEqual({ pages: 6, method: "text-pages" });
  });

  it("counts slides from the PPTX container without converting it", async () => {
    const names = ["[Content_Types].xml", "ppt/slides/slide1.xml", "ppt/slides/slide2.xml", "ppt/slides/slide3.xml", "ppt/slides/_rels/slide1.xml.rels", "ppt/slideLayouts/slideLayout1.xml"];
    const result = await measureDocumentPages(fakeDeps({ bytes: zipWithNames(names) }), document("deck.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"), "office-pptx");
    expect(result).toEqual({ pages: 3, method: "slides" });
  });

  it("caps a runaway count at the ceiling", async () => {
    const result = await measureDocumentPages(fakeDeps({ pdfPages: 99_999_999 }), document("x.docx", DOCX), "office-word");
    expect(result?.pages).toBe(100_000);
  });
});

describe("parsePdfInfoPages", () => {
  it("reads the page count and rejects missing or hostile values", () => {
    expect(parsePdfInfoPages("Pages: 7\n")).toBe(7);
    expect(parsePdfInfoPages("Title: Pages: 99\nProducer: x\n")).toBeNull();
    expect(parsePdfInfoPages("Pages: 0\n")).toBeNull();
  });
});

function zipWithNames(names: string[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const name of names) {
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(names.length, 8);
  end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
