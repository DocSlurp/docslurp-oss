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
function fakeDeps(options: { pdfPages?: number; sidecar?: unknown; sofficeFails?: boolean; bytes?: Buffer }): PageCountDeps {
  const available = (binary: string, ...args: string[]) => ({ binary, args, available: true });
  return {
    runner: {
      officeToPdf: async (source: string, outdir: string) => available("soffice", "--convert-to", "pdf", source, "--outdir", outdir),
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

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("recordMeasuredPageCount", () => {
  it("ends a 300-page DOCX with its real page count in documents.page_count", async () => {
    const doc = document("contract.docx", DOCX);
    const setDocumentPageCount = vi.fn(async () => true);
    const result = await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentPageCount } }, fakeDeps({ pdfPages: 300 }), doc, "office-word");
    expect(result).toEqual({ pages: 300, method: "pdf-conversion", intakePages: 1 });
    expect(setDocumentPageCount).toHaveBeenCalledWith("run-1", "doc-1", 300);
    expect(doc.pageCount).toBe(300);
  });

  it("keeps the intake count when the conversion fails, and says nothing was measured", async () => {
    const doc = document("broken.docx", DOCX, 1);
    const setDocumentPageCount = vi.fn(async () => true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentPageCount } }, fakeDeps({ sofficeFails: true }), doc, "office-word");
    expect(result).toEqual({ pages: null, method: null, intakePages: 1 });
    expect(setDocumentPageCount).not.toHaveBeenCalled();
    expect(doc.pageCount).toBe(1);
    warn.mockRestore();
  });

  it("does not touch formats the server already counts (PDF, text, images)", async () => {
    const doc = document("a.pdf", "application/pdf", 12);
    const setDocumentPageCount = vi.fn(async () => true);
    expect(await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentPageCount } }, fakeDeps({}), doc, "pdf")).toMatchObject({ pages: null });
    expect(setDocumentPageCount).not.toHaveBeenCalled();
  });
});

describe("measureDocumentPages", () => {
  it("counts a spreadsheet's sheets by the text rule, so a long sheet is many pages", async () => {
    const longSheet = Array.from({ length: 600 }, (_, row) => `r${row},${row}`).join("\n");
    const result = await measureDocumentPages(fakeDeps({ sidecar: { sheets: [{ csv: longSheet }, { csv: "a,b\n1,2" }, { csv: "" }] } }), document("book.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), "office-excel");
    expect(result).toEqual({ pages: 11, method: "sheet-rows" });
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
