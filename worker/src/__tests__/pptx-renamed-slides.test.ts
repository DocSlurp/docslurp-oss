import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { listZipEntryNames } from "@docslurp/shared";
import { afterAll, describe, expect, it, vi } from "vitest";

import { measureExtractedPages, recordMeasuredPageCount } from "../lib/office-page-count.js";
import type { Document } from "../models.js";

const python = process.env.OFFICE_TEST_PYTHON ?? "python3";
const scripts = path.resolve(import.meta.dirname, "../../scripts");
const hasOfficeLibs = spawnSync(python, ["-c", "import pptx"]).status === 0;

/**
 * Council A M2: a deck whose slide parts are renamed (ppt/slides/page7.xml, still listed by presentation.xml) counted 1 by the old
 * ZIP-name count while python-pptx reads every slide. The count now comes from the extractor's own slide list.
 */
describe.skipIf(!hasOfficeLibs)("a PPTX with renamed slide parts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pptx-renamed-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("bills every slide python-pptx reads, not the slide parts a ZIP listing finds by name", () => {
    const deck = path.join(dir, "crafted.pptx");
    execFileSync(python, ["-c", [
      "import re, sys, zipfile",
      "from pptx import Presentation",
      "prs = Presentation()",
      "for n in range(50):",
      "    slide = prs.slides.add_slide(prs.slide_layouts[1])",
      "    slide.shapes.title.text = f'Slide {n + 1}'",
      "plain = sys.argv[1] + '.plain'",
      "prs.save(plain)",
      "rename = lambda name: re.sub(r'slides/(_rels/)?slide(\\d+)\\.xml', lambda m: f'slides/{m.group(1) or \"\"}page{m.group(2)}.xml', name)",
      "with zipfile.ZipFile(plain) as src, zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as out:",
      "    for item in src.infolist():",
      "        data = src.read(item.filename)",
      "        if item.filename in ('[Content_Types].xml', 'ppt/_rels/presentation.xml.rels'):",
      "            data = re.sub(rb'slides/slide(\\d+)\\.xml', rb'slides/page\\1.xml', data)",
      "        out.writestr(rename(item.filename), data)",
    ].join("\n"), deck]);
    const names = listZipEntryNames(readFileSync(deck))!;
    expect(names.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(0); // what the old count read

    execFileSync(python, [path.join(scripts, "office_markdown.py"), "--kind", "pptx", "--input", deck, "--output", `${deck}.md`]);
    const markdown = readFileSync(`${deck}.md`, "utf8");
    expect(measureExtractedPages("office-pptx", "pptx", markdown)).toEqual({ pages: 50, method: "slides" });
  });
});

describe("a measured count never bills below the page basis", () => {
  it("keeps a counted page_count when the extractor's output counts fewer pages; an assumed one is no floor", async () => {
    const assumed = { id: "doc-2", userId: "u", runId: "run-1", filename: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sourceKey: "k", status: "queued", extractionMode: "hybrid", pageCount: 12, pageCountSource: "assumed", createdAt: new Date(), updatedAt: new Date() } as Document;
    const recorded = vi.fn(async () => true);
    expect((await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentBillingPages: recorded } }, assumed, "office-pptx", { extractor: "pptx", markdown: "## One\n\f\n## Two" })).pages).toBe(2);
    const document = { id: "doc-1", userId: "u", runId: "run-1", filename: "deck.pptx", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", sourceKey: "k", status: "queued", extractionMode: "hybrid", pageCount: 12, pageCountSource: "counted", createdAt: new Date(), updatedAt: new Date() } as Document;
    const setDocumentBillingPages = vi.fn(async () => true);
    const result = await recordMeasuredPageCount({ run: { id: "run-1" }, store: { setDocumentBillingPages } }, document, "office-pptx", { extractor: "pptx", markdown: "## One\n\f\n## Two" });
    expect(result.pages).toBe(12);
    expect(setDocumentBillingPages).toHaveBeenCalledWith("run-1", "doc-1", 12, "slides");
  });
});
