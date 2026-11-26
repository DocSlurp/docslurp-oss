import { deflateRawSync } from "node:zlib";

import { defaultPipelineFeatures, estimateProfileFor, FILE_PROFILE_SCHEMA, quoteFilePageRange, quoteHighIsCeiling, quoteUpload, WORKER_COUNTED_MAX_PAGES } from "@docslurp/shared";
import { describe, expect, it } from "vitest";

import { measureExtractedPages } from "../lib/office-page-count.js";

/*
 * DocSlurp/app issue 601: the upload quote cannot know a Word, slide, sheet or EPUB file's pages before conversion, so it prices
 * them over a range of bytes per page (shared upload-pages.ts). The worker bills what it measures after conversion; the quote's
 * high end must cover what dense but ordinary files of each format measure, or the final charge exceeds the quoted maximum.
 *
 * Each package below is sized exactly as a zip of its parts (local header, central directory entry and raw deflate of each
 * entry, plus the end record), with only the parts that hold the content: a real file carries styles, themes and properties
 * besides, so it is larger and its quote wider. The Markdown is what the format's extractor writes for that content.
 *
 * With a file profile (the offline estimator's `office.bodyBytes`, the body parts' uncompressed size) every Word, slide and
 * EPUB case is covered: the high end is a ceiling. From the size alone no divisor covers repetitive content without quoting
 * every ordinary report at the worker's page cap, so the size gives an ordinary range and the quote says it is not a ceiling
 * (quoteHighIsCeiling, CostEstimate.unboundedFiles). A sheet is never bounded (its cells can repeat one long shared string).
 */
function zipBytes(entries: ReadonlyArray<readonly [name: string, data: string]>): number {
  return entries.reduce((total, [name, data]) => total + 30 + 46 + 2 * Buffer.byteLength(name) + deflateRawSync(Buffer.from(data), { level: 6 }).length, 22);
}

const words = (() => {
  // A fixed pseudo-random vocabulary, so the text compresses like prose and the test is deterministic.
  let seed = 7;
  const next = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const vocabulary = Array.from({ length: 3_000 }, () => Array.from({ length: 2 + Math.floor(next() * 9) }, () => String.fromCharCode(97 + Math.floor(next() * 26))).join(""));
  return (count: number) => Array.from({ length: count }, () => vocabulary[Math.floor(next() * vocabulary.length)]).join(" ");
})();

const w = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const docx = (paragraphs: readonly string[]) => [["word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join("")}</w:body></w:document>`]] as const;

const clause = words(90);
const CASES = [
  {
    name: "contract.docx (one clause template, 1,200 numbered clauses)",
    file: { name: "contract.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    parts: docx(Array.from({ length: 1_200 }, (_, index) => `${w(`Clause ${index + 1}`)}${w(clause)}`)),
    format: "office-word", extractor: "pandoc", sizeOnly: false,
    markdown: Array.from({ length: 1_200 }, (_, index) => `## Clause ${index + 1}\n\n${clause}`).join("\n\n"),
  },
  {
    name: "report.docx (a 20,000-row status table)",
    file: { name: "report.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
    parts: docx([`<w:tbl>${Array.from({ length: 20_000 }, (_, index) => `<w:tr>${[String(index + 1), "ok", String(100 + (index % 7))].map((cell) => `<w:tc>${w(cell)}</w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`]),
    format: "office-word", extractor: "pandoc", sizeOnly: true,
    markdown: `| id | status | amount |\n|---|---|---|\n${Array.from({ length: 20_000 }, (_, index) => `| ${index + 1} | ok | ${100 + (index % 7)} |`).join("\n")}`,
  },
  {
    name: "handbook.epub (the clause template, one chapter)",
    file: { name: "handbook.epub", type: "application/epub+zip" },
    parts: [["mimetype", "application/epub+zip"], ["EPUB/text/ch001.xhtml", `<html xmlns="http://www.w3.org/1999/xhtml"><body>${Array.from({ length: 1_200 }, (_, index) => `<h2>Clause ${index + 1}</h2><p>${clause}</p>`).join("")}</body></html>`]] as const,
    format: "epub", extractor: "pandoc", sizeOnly: false,
    markdown: Array.from({ length: 1_200 }, (_, index) => `## Clause ${index + 1}\n\n${clause}`).join("\n\n"),
  },
  {
    name: "ids.xlsx (100,000 sequential ids in one column)",
    file: { name: "ids.xlsx", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    parts: [["xl/worksheets/sheet1.xml", `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${Array.from({ length: 100_000 }, (_, index) => `<row r="${index + 1}"><c r="A${index + 1}"><v>${index + 1}</v></c></row>`).join("")}</sheetData></worksheet>`]] as const,
    format: "office-excel", extractor: "xlsx", sizeOnly: true,
    markdown: `## Sheet1\n\n| A |\n| --- |\n${Array.from({ length: 100_000 }, (_, index) => `| ${index + 1} |`).join("\n")}\n`,
  },
  {
    name: "launch.pptx (500 one-line slides)",
    file: { name: "launch.pptx", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
    parts: Array.from({ length: 500 }, (_, index) => [
      [`ppt/slides/slide${index + 1}.xml`, `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Slide ${index + 1}</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content 2"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>${words(6)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`],
      [`ppt/slides/_rels/slide${index + 1}.xml.rels`, `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout2.xml"/></Relationships>`],
    ] as const).flat(),
    format: "office-pptx", extractor: "pptx", sizeOnly: true,
    markdown: Array.from({ length: 500 }, (_, index) => `## Slide ${index + 1}\n\n- ${words(6)}`).join("\n\f\n"),
  },
] as const;

/** What the offline estimator reports as `office.bodyBytes`: the uncompressed size of the body parts (probe/office.rs). */
const bodyBytes = (parts: ReadonlyArray<readonly [string, string]>) => parts
  .filter(([name]) => name === "word/document.xml" || /^ppt\/slides\/slide\d+\.xml$/.test(name) || /^xl\/worksheets\/sheet\d+\.xml$/.test(name) || /\.x?html?$/.test(name))
  .reduce((total, [, data]) => total + Buffer.byteLength(data), 0);

describe("the quote's high end covers what dense converted files measure", () => {
  it.each(CASES.filter((entry) => entry.format !== "office-excel"))("$name, with the file's profile: the range covers it, still not a ceiling", (entry) => {
    const size = zipBytes(entry.parts);
    const measured = measureExtractedPages(entry.format, entry.extractor, entry.markdown)!;
    const file = { ...entry.file, size, profile: { office: { bodyBytes: bodyBytes(entry.parts) } } };
    const range = quoteFilePageRange(file);
    expect(measured.pages).toBeGreaterThan(1);
    expect(range.measured).toBe(false);
    expect(quoteHighIsCeiling(file)).toBe(false);
    expect(quoteHighIsCeiling({ ...file, pages: 1 })).toBe(false);
    expect(measured.pages, `${entry.name}: ${size} bytes measured ${measured.pages} pages, quoted at most ${range.high}`).toBeLessThanOrEqual(range.high);
  });

  it.each(CASES)("$name, from its size alone: the quote says its high end is not a ceiling", (entry) => {
    const size = zipBytes(entry.parts);
    expect(quoteFilePageRange({ ...entry.file, size }).measured).toBe(false);
    expect(quoteHighIsCeiling({ ...entry.file })).toBe(false);
  });

  it("a sheet is never a ceiling, profile or not (shared strings are outside the worksheet parts)", () => {
    const sheet = CASES.find((entry) => entry.format === "office-excel")!;
    const file = { ...sheet.file, size: zipBytes(sheet.parts), profile: { office: { bodyBytes: bodyBytes(sheet.parts) } } };
    expect(quoteHighIsCeiling(file)).toBe(false);
    // The worksheet's body size never widens a sheet's range: it bounds nothing.
    expect(quoteFilePageRange(file).high).toBe(quoteFilePageRange({ ...sheet.file, size: file.size }).high);
  });

  it("the estimate names the files whose high end is not a ceiling, whichever provider priced it", () => {
    const profile = estimateProfileFor(defaultPipelineFeatures, { env: {} });
    const word = { name: "a.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", size: 5 * 1024 * 1024 };
    const bare = quoteUpload({ files: [word, { name: "b.xlsx", size: 1024 * 1024 }, { name: "c.pdf", type: "application/pdf", size: 1024 * 1024, pages: 4 }], profile }).estimate;
    expect(bare.unboundedFiles).toBe(2);
    expect(bare.basis).toContain("not a ceiling for 2");
    const profiled = quoteUpload({ files: [{ ...word, profile: { schema: FILE_PROFILE_SCHEMA, profiler: "test", kind: "office", format: "docx", bytes: word.size, office: { embeddedImages: 0, bodyBytes: 20 * 1024 * 1024 } } }], profile }).estimate;
    expect(profiled.unboundedFiles).toBe(1);
  });

  it("ordinary files quote ordinary ranges from their size; only a profile widens toward the worker's cap", () => {
    const docx = { name: "report.docx", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };
    // 1, 5 and 20 MB: 1,024 bytes a page at the high end (not the 100,000-page cap a 128-byte divisor gave a 20 MB report).
    expect([1, 5, 20].map((mb) => quoteFilePageRange({ ...docx, size: mb * 1024 * 1024 }).high)).toEqual([1_024, 5_120, 20_480]);
    const file = { ...docx, size: 64 * 1024 };
    const sizeOnly = quoteFilePageRange(file);
    expect(quoteFilePageRange({ ...file, profile: { office: { bodyBytes: 0 } } }).high).toBe(sizeOnly.high);
    expect(quoteFilePageRange({ ...file, profile: { office: { bodyBytes: 10 ** 13 } } }).high).toBe(WORKER_COUNTED_MAX_PAGES);
    expect(quoteFilePageRange({ ...file, size: 10 ** 12 }).high).toBe(WORKER_COUNTED_MAX_PAGES);
  });
});
