import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { measureExtractedPages, recordMeasuredPageCount } from "../lib/office-page-count.js";
import type { Document } from "../models.js";

/**
 * Owner rule: a number that drives billing, authorization, routing, limits or security never comes from text the document's
 * author controls (Office docProps, PDF Info/XMP, EXIF, file names, "Page 3 of 200" in the body). Office pages are measured
 * from the extractor's own output; nothing reads a document's declared page, slide or word count.
 */
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const paragraph = "The supplier shall deliver the goods to the buyer at the agreed place and time, as set out in schedule one. ".repeat(6);

describe("an Office file's declared counts never bill", () => {
  it("a DOCX whose app.xml says <Pages>1</Pages> bills the pages its text holds", async () => {
    // A real DOCX container: app.xml claims 1 page and 10 words; the body holds ~300 pages of text and says "Page 1 of 1".
    const dir = await mkdtemp(path.join(process.env.TMPDIR || tmpdir(), "docprops-"));
    const root = path.join(dir, "doc");
    await mkdir(path.join(root, "docProps"), { recursive: true });
    await mkdir(path.join(root, "word"), { recursive: true });
    await writeFile(path.join(root, "docProps/app.xml"), `<?xml version="1.0"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Pages>1</Pages><Words>10</Words></Properties>`);
    const body = Array.from({ length: 1_500 }, (_, index) => `<w:p><w:r><w:t>${index === 0 ? "Page 1 of 1. " : ""}${paragraph}</w:t></w:r></w:p>`).join("");
    await writeFile(path.join(root, "word/document.xml"), `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`);
    const file = path.join(dir, "contract.docx");
    execFileSync("zip", ["-qr", file, "."], { cwd: root });
    // The extractor's output is the body's text (what pandoc writes for these paragraphs); app.xml is not part of it.
    const xml = execFileSync("unzip", ["-p", file, "word/document.xml"]).toString("utf8");
    const markdown = [...xml.matchAll(/<w:t>([^<]*)<\/w:t>/g)].map((match) => match[1]).join("\n\n");
    const measured = measureExtractedPages("office-word", "pandoc", markdown)!;
    expect(measured.method).toBe("text-rule");
    expect(measured.pages).toBeGreaterThan(250);
    const setDocumentBillingPages = vi.fn(async () => true);
    const document = { id: "doc-1", runId: "run-1", pageCount: 1, pageCountSource: "assumed", mimeType: DOCX } as Document;
    expect((await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentBillingPages } }, document, "office-word", { extractor: "pandoc", markdown })).pages).toBe(measured.pages);
  });
});

describe("no billing, limit or routing code reads document-declared counts", () => {
  it("nothing reads docProps page/slide/word counts, XMP page counts or 'Page N of M' text", async () => {
    const worker = path.resolve(import.meta.dirname, "..", "..");
    const roots = ["src", "scripts", "../server/src", "../packages/shared/src"].map((dir) => path.resolve(worker, dir));
    const files: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (!["__tests__", "node_modules", "dist", "test"].includes(entry.name)) await walk(full); }
        else if (/\.(ts|mjs|py)$/.test(entry.name) && !/\.test\.|test_/.test(entry.name)) files.push(full);
      }
    };
    for (const root of roots) await walk(root);
    expect(files.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      // Office extended properties, XMP's page count, and a regex parsing "Page N of M" out of text.
      if (/docProps\/app\.xml|<(?:Pages|Slides|Words)>|xmpTPg:NPages|[Pp]age\\s[+*]\(?\\d\+\)?\\s[+*]of/.test(text)) offenders.push(path.relative(worker, file));
    }
    expect(offenders).toEqual([]);
  });
});
