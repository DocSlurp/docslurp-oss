import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { strToU8, zipSync } from "fflate";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { documentExtractorRegistry } from "../extractors/registry.js";
import { CommandRunner, EMPTY_TESSDATA_DIR } from "../tools/runner.js";

/*
 * Kreuzberg never OCRs: it links an OCR engine, so the worker passes it the sniffed MIME type, refuses images, turns its
 * OCR off and points its language data at an empty directory. A document with text only inside an embedded image must
 * come back without that text.
 */

const script = fileURLToPath(new URL("../../scripts/kreuzberg_extract.mjs", import.meta.url));
const liteparseScript = fileURLToPath(new URL("../../scripts/liteparse_extract.mjs", import.meta.url));
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const IMAGE_ONLY_WORDS = "QUARTERLY INVOICE ZEBRA 48213";

async function textPng(text: string): Promise<Uint8Array> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="200"><rect width="100%" height="100%" fill="white"/>` +
    `<text x="40" y="120" font-family="sans-serif" font-size="72" fill="black">${text}</text></svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

/** A one-page PDF whose only content is a JPEG of `text`: no text layer at all. */
async function imageOnlyPdf(text: string): Promise<Buffer> {
  const jpeg = await sharp(await textPng(text)).flatten({ background: "white" }).jpeg({ quality: 90 }).toBuffer();
  const width = 1400, height = 200;
  const draw = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`,
    null,
    `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`,
  ];
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, index) => {
    offsets.push(length);
    const chunk = body === null
      ? Buffer.concat([Buffer.from(`${index + 1} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`), jpeg, Buffer.from("\nendstream\nendobj\n")])
      : Buffer.from(`${index + 1} 0 obj\n${body}\nendobj\n`);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  return Buffer.concat([...parts, Buffer.from(xref)]);
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
beforeEach(async () => { scratch = await mkdtemp(path.join(tmpdir(), "kreuzberg-no-ocr-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(scratch, { recursive: true, force: true }); });

describe("Kreuzberg never OCRs", () => {
  it("returns a DOCX's text but not the words inside its embedded image, even when asked to OCR", async () => {
    // No .docx extension: Kreuzberg reads it as a DOCX only because the sniffed MIME type is passed (and the worker's
    // office-context helper, which needs the Python venv, stays out of this test).
    const input = path.join(scratch, "report.bin");
    const output = path.join(scratch, "report.md");
    await writeFile(input, docxWithImage(await textPng(IMAGE_ONLY_WORDS)));
    // A hostile or stale config asking for OCR is dropped by the script.
    const config = JSON.stringify({ forceOcr: true, ocr: { backend: "tesseract", language: "eng" } });
    await promisify(execFile)(process.execPath, [script, "--input", input, "--output", output, "--config-json", config, "--mime-type", DOCX_MIME], {
      timeout: 120_000, env: { PATH: process.env.PATH ?? "", HOME: scratch },
    });
    const markdown = await readFile(output, "utf8");
    expect(markdown).toContain("Plain paragraph text.");
    for (const word of IMAGE_ONLY_WORDS.split(" ")) expect(markdown.toUpperCase()).not.toContain(word);
  }, 150_000);

  it("refuses an image by its sniffed MIME type whatever the file is named", async () => {
    const input = path.join(scratch, "scan.docx");
    await writeFile(input, await textPng(IMAGE_ONLY_WORDS));
    await expect(promisify(execFile)(process.execPath, [script, "--input", input, "--output", path.join(scratch, "out.md"), "--mime-type", "image/png"], { timeout: 60_000 }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("images are read by the OCR engine") });
  });

  it("plans Kreuzberg with the sniffed MIME type and an empty OCR language-data directory", async () => {
    const runner = new CommandRunner();
    const docx = await documentExtractorRegistry.prepare("kreuzberg", runner, path.join(scratch, "report.bin"), undefined, { format: "docx", mimeType: DOCX_MIME });
    expect(docx.plan.args.slice(-2)).toEqual(["--mime-type", DOCX_MIME]);
    expect(docx.plan.bundleEnv?.TESSDATA_PREFIX).toBe(EMPTY_TESSDATA_DIR);
    // A sniffed image MIME refuses the plan, whatever the extension or format hint says.
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const image = await documentExtractorRegistry.prepare("kreuzberg", runner, path.join(scratch, "report.pdf"), undefined, { format: "pdf", mimeType: "image/tiff" });
    expect(image.plan.available).toBe(false);
    // A MIME type that is not a plain type/subtype never reaches the command line.
    const odd = await documentExtractorRegistry.prepare("kreuzberg", runner, path.join(scratch, "report.bin"), undefined, { format: "docx", mimeType: "text/plain; --config-json={}" });
    expect(odd.plan.args).not.toContain("--mime-type");
  });

  it("never lets LiteParse OCR: no OCR flag, empty language data, and no text from an image-only PDF", async () => {
    const runner = new CommandRunner();
    await expect(runner.liteParseExtract(path.join(scratch, "a.pdf"), path.join(scratch, "a.json"), true)).rejects.toThrow(/LiteParse OCR is refused/);
    const plan = await runner.liteParseExtract(path.join(scratch, "a.pdf"), path.join(scratch, "a.json"));
    expect(plan.args).not.toContain("--ocr");
    expect(plan.bundleEnv?.TESSDATA_PREFIX).toBe(EMPTY_TESSDATA_DIR);
    const input = path.join(scratch, "scan.pdf");
    const output = path.join(scratch, "scan.json");
    await writeFile(input, await imageOnlyPdf(IMAGE_ONLY_WORDS));
    await promisify(execFile)(process.execPath, [liteparseScript, "--input", input, "--output", output], {
      timeout: 120_000, env: { PATH: process.env.PATH ?? "", HOME: scratch },
    });
    const result = JSON.parse(await readFile(output, "utf8")) as { markdown: string; diagnostics: { ocrEnabled: boolean } };
    expect(result.diagnostics.ocrEnabled).toBe(false);
    for (const word of IMAGE_ONLY_WORDS.split(" ")) expect(result.markdown.toUpperCase()).not.toContain(word);
    await expect(promisify(execFile)(process.execPath, [liteparseScript, "--input", input, "--output", output, "--ocr"], { timeout: 60_000 }))
      .rejects.toMatchObject({ stderr: expect.stringContaining("liteparse OCR refused") });
  }, 150_000);

  it("reads a stored image order that still names kreuzberg with the ocr extractor instead of throwing", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(documentExtractorRegistry.resolve("image", ["kreuzberg"])).toEqual(["ocr"]);
    expect(documentExtractorRegistry.resolve("image", ["kreuzberg", "ocr"])).toEqual(["ocr"]);
    expect(warn).toHaveBeenCalled();
    expect(() => documentExtractorRegistry.resolve("image", ["no-such-extractor"])).toThrow(/unknown extractor/);
  });
});
