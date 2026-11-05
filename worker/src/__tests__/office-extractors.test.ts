import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { strToU8, zipSync } from "fflate";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { documentExtractorRegistry, pandocReader } from "../extractors/registry.js";
import { CommandRunner } from "../tools/runner.js";

/*
 * The retired Kreuzberg and LiteParse addons linked Tesseract into the worker. Their formats now go to extractors that
 * link no OCR engine and run in the parser sandbox: Pandoc (with --sandbox and the sniffed format's reader), and the
 * python-pptx / openpyxl sidecar (scripts/office_markdown.py). PDFs keep their PDF extractors; images the ocr extractor.
 */

const officeScript = fileURLToPath(new URL("../../scripts/office_markdown.py", import.meta.url));
const IMAGE_ONLY_WORDS = "QUARTERLY INVOICE ZEBRA 48213";
const has = (binary: string, args: string[]): boolean => {
  try { execFileSync(binary, args, { stdio: "ignore", timeout: 20_000 }); return true; } catch { return false; }
};
const pandocInstalled = has("pandoc", ["--version"]);
const pythonOffice = process.env.PYTHON_VENV ? path.join(process.env.PYTHON_VENV, "bin", "python3") : "python3";
const officePythonInstalled = has(pythonOffice, ["-c", "import pptx, openpyxl, defusedxml"]);

async function textPng(text: string): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="200"><rect width="100%" height="100%" fill="white"/>` +
    `<text x="40" y="120" font-family="sans-serif" font-size="72" fill="black">${text}</text></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

/** A minimal DOCX: one paragraph of real text and one inline picture whose pixels carry other words. */
function docxWithImage(png: Uint8Array): Uint8Array {
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/></Relationships>`;
  const emu = (px: number) => px * 9525;
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>` +
    `<w:p><w:r><w:t>Plain paragraph text.</w:t></w:r></w:p>` +
    `<w:p><w:r><w:drawing><wp:inline><wp:extent cx="${emu(700)}" cy="${emu(100)}"/><wp:docPr id="1" name="Picture 1"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
    `<pic:nvPicPr><pic:cNvPr id="1" name="image1.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(700)}" cy="${emu(100)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`;
  return zipSync({
    "[Content_Types].xml": strToU8(ct),
    "_rels/.rels": strToU8(rels),
    "word/document.xml": strToU8(doc),
    "word/_rels/document.xml.rels": strToU8(docRels),
    "word/media/image1.png": png,
  });
}

let scratch: string;
beforeEach(async () => { scratch = await mkdtemp(path.join(tmpdir(), "office-extractors-")); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(scratch, { recursive: true, force: true }); });

describe("default extractor order per format", () => {
  it("routes every format the retired parsers read to an extractor that links no OCR engine", () => {
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "");
    expect(documentExtractorRegistry.resolve("pdf")).toEqual(["doppler-md", "native-pdf", "poppler-text"]);
    for (const format of ["office-word", "office-other", "epub", "html", "plain-text", "markdown", "structured-csv", "latex"]) {
      expect(documentExtractorRegistry.resolve(format), format).toEqual(["pandoc"]);
    }
    expect(documentExtractorRegistry.resolve("office-pptx")).toEqual(["pptx"]);
    expect(documentExtractorRegistry.resolve("office-excel")).toEqual(["xlsx"]);
    expect(documentExtractorRegistry.resolve("image")).toEqual(["ocr"]);
    expect(documentExtractorRegistry.list().map((entry) => entry.id)).not.toEqual(expect.arrayContaining(["kreuzberg"]));
    expect(documentExtractorRegistry.list().map((entry) => entry.id)).not.toEqual(expect.arrayContaining(["liteparse"]));
  });

  it("drops a retired id from a configured order, so a sandboxed PDF deployment still routes PDFs to vm-pdf only", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "vm-pdf");
    expect(documentExtractorRegistry.resolve("pdf", ["kreuzberg"])).toEqual(["vm-pdf"]);
    expect(documentExtractorRegistry.resolve("pdf", ["liteparse", "kreuzberg"])).toEqual(["vm-pdf"]);
    vi.stubEnv("DOCSLURP_PDF_EXTRACTOR", "");
    expect(documentExtractorRegistry.resolve("office-pptx", ["kreuzberg"])).toEqual(["pptx"]);
    expect(documentExtractorRegistry.resolve("image", ["kreuzberg"])).toEqual(["ocr"]);
    expect(documentExtractorRegistry.resolve("office-word", ["kreuzberg", "pandoc"])).toEqual(["pandoc"]);
    expect(warn).toHaveBeenCalled();
  });

  it("still fails closed on unknown ids and on extractors that do not read the format", () => {
    expect(() => documentExtractorRegistry.resolve("pdf", ["tesseract"])).toThrow(/unknown extractor/);
    expect(() => documentExtractorRegistry.resolve("office-pptx", ["pandoc"])).toThrow(/does not support/);
    expect(() => documentExtractorRegistry.resolve("image", ["pandoc"])).toThrow(/does not support/);
  });
});

describe("planning", () => {
  const runner = new CommandRunner();

  it("runs Pandoc with --sandbox and the reader the sniffed format names, never one the file name picks", async () => {
    const source = path.join(scratch, "upload.docx");
    const html = await documentExtractorRegistry.prepare("pandoc", runner, source, undefined, { format: "html" });
    expect(html.plan.args).toEqual(expect.arrayContaining(["--sandbox", "-f", "html", "-t", "gfm"]));
    expect(html.plan.args.at(-1)).toBe(source);
    expect(pandocReader(path.join(scratch, "a.tsv"), { format: "structured-csv" })).toBe("tsv");
    expect(pandocReader(path.join(scratch, "a.csv"), { format: "structured-csv" })).toBe("csv");
    expect(pandocReader(path.join(scratch, "a.odt"), { format: "office-other" })).toBe("odt");
    expect(pandocReader(path.join(scratch, "a.rtf"), { format: "office-other" })).toBe("rtf");
    expect(pandocReader(path.join(scratch, "a.tex"), { format: "latex" })).toBe("latex");
  });

  it("reads .docx through the office sidecar (Pandoc plus source context), in the sandbox like other scripts", async () => {
    const docx = await documentExtractorRegistry.prepare("pandoc", runner, path.join(scratch, "a.docx"), undefined, { format: "office-word" });
    expect(path.basename(docx.plan.args[0]!)).toBe("office_markdown.py");
    expect(docx.plan.args).toEqual(expect.arrayContaining(["--kind", "docx"]));
    for (const [id, kind, format] of [["pptx", "pptx", "office-pptx"], ["xlsx", "xlsx", "office-excel"]] as const) {
      const prepared = await documentExtractorRegistry.prepare(id, runner, path.join(scratch, `a.${kind}`), undefined, { format });
      expect(prepared.plan.args).toEqual(expect.arrayContaining(["--kind", kind]));
      expect(prepared.outputPath).toBe(path.join(scratch, `a.${kind}.${kind}.md`));
    }
  });

  it("plans legacy binary Office files and a hostile reader as unavailable or refused", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const doc = await documentExtractorRegistry.prepare("pandoc", runner, path.join(scratch, "a.doc"), undefined, { format: "office-other", mimeType: "application/msword" });
    expect(doc.plan.available).toBe(false);
    const ppt = await documentExtractorRegistry.prepare("pptx", runner, path.join(scratch, "a.ppt"), undefined, { format: "office-pptx", mimeType: "application/vnd.ms-powerpoint" });
    expect(ppt.plan.available).toBe(false);
    const xls = await documentExtractorRegistry.prepare("xlsx", runner, path.join(scratch, "a.bin"), undefined, { format: "office-excel", mimeType: "application/vnd.ms-excel" });
    expect(xls.plan.available).toBe(false);
    await expect(runner.extractMarkdown(path.join(scratch, "a.txt"), "lua")).rejects.toThrow(/unsupported pandoc reader/);
  });
});

describe("no OCR on the host", () => {
  it.runIf(pandocInstalled && officePythonInstalled)("returns a DOCX's text but not the words inside its embedded image", async () => {
    const input = path.join(scratch, "report.docx");
    const output = path.join(scratch, "report.md");
    await writeFile(input, docxWithImage(await textPng(IMAGE_ONLY_WORDS)));
    await promisify(execFile)(pythonOffice, [officeScript, "--kind", "docx", "--input", input, "--output", output], { timeout: 120_000 });
    const markdown = await readFile(output, "utf8");
    expect(markdown).toContain("Plain paragraph text.");
    for (const word of IMAGE_ONLY_WORDS.split(" ")) expect(markdown.toUpperCase()).not.toContain(word);
  }, 150_000);

  it.runIf(officePythonInstalled)("fails cleanly on bytes that are not an Office file, and on a hostile ZIP", async () => {
    const garbage = path.join(scratch, "garbage.pptx");
    await writeFile(garbage, Buffer.from("%PDF-1.4 not a presentation"));
    await expect(promisify(execFile)(pythonOffice, [officeScript, "--kind", "pptx", "--input", garbage, "--output", path.join(scratch, "g.md")], { timeout: 60_000 }))
      .rejects.toBeTruthy();
    // A ZIP whose workbook part points outside the archive (a path-traversal relationship) must not read the host.
    const evil = path.join(scratch, "evil.xlsx");
    await writeFile(evil, zipSync({
      "[Content_Types].xml": strToU8("<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>"),
      "xl/workbook.xml": strToU8("<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheets/></workbook>"),
      "xl/_rels/workbook.xml.rels": strToU8("<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Target=\"../../../../etc/passwd\" Type=\"x/worksheet\"/></Relationships>"),
    }));
    const out = path.join(scratch, "evil.md");
    await promisify(execFile)(pythonOffice, [officeScript, "--kind", "xlsx", "--input", evil, "--output", out], { timeout: 60_000 }).catch(() => undefined);
    const text = await readFile(out, "utf8").catch(() => "");
    expect(text).not.toMatch(/root:x:0:0/);
  }, 120_000);
});
