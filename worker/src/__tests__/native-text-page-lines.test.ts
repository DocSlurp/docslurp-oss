import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { buildCanonicalChunksFromDocument, buildCanonicalDocumentFromMarkdown } from "../lib/canonical-document.js";
import { reconcileCanonicalArtifacts } from "../lib/canonical-reconciliation.js";
import { buildExtractionContract } from "../lib/extraction-contract.js";
import { normalizeExtractedMarkdown } from "../lib/extracted-markdown.js";
import { buildTestPdf, proseLines } from "../test/make-pdf.js";

const kreuzbergScript = fileURLToPath(new URL("../../scripts/kreuzberg_extract.mjs", import.meta.url));
const squash = (text: string) => text.replace(/\s+/g, " ");

/**
 * Regression: native-text PDFs lost lines at page boundaries. Kreuzberg Markdown had no page
 * breaks, so the canonical document sliced it into equal-length "pages", cutting a heading
 * mid-word; a page-level replacement (vision reconciliation) then dropped the misplaced lines.
 */
describe("native text keeps every line on its own page", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("through extraction, canonical blocks, page replacement and chunking", async () => {
    const pageCount = 8;
    const pages = Array.from({ length: pageCount }, (_, index) => ({
      heading: `Section ${index + 1} quarterly harbor operations summary`,
      // Uneven page lengths move the old equal-length slice points off page boundaries.
      lines: [`Marker line for page ${index + 1} granite`, ...proseLines(14 + ((index * 7) % 23), index + 11)],
    }));
    const dir = await mkdtemp(path.join(tmpdir(), "native-lines-"));
    dirs.push(dir);
    const input = path.join(dir, "doc.pdf");
    const output = path.join(dir, "doc.md");
    await writeFile(input, buildTestPdf(pages.map((page) => ({ kind: "text" as const, ...page }))));
    await promisify(execFile)(process.execPath, [kreuzbergScript, "--input", input, "--output", output], { timeout: 60_000 });
    const markdown = normalizeExtractedMarkdown({ markdown: await readFile(output, "utf8"), preserveTables: true });

    const canonicalDocument = buildCanonicalDocumentFromMarkdown({ documentId: "doc", text: markdown, pageCount, extractor: "kreuzberg" });
    const pageText = (document: typeof canonicalDocument, pageNumber: number) =>
      squash(document.blocks.filter((block) => block.pageNumber === pageNumber).map((block) => block.text).join("\n"));
    pages.forEach((page, index) => {
      const text = pageText(canonicalDocument, index + 1);
      expect(text).toContain(`# ${page.heading}`);
      expect(text).toContain(page.lines[0]);
      expect(text).toContain(page.lines[page.lines.length - 1]);
    });

    // Replace one page with a faithful re-read of that page (what vision reconciliation does).
    const extractionContract = buildExtractionContract({
      documentId: "doc", markdown, extractor: "kreuzberg", strategy: "fast", extractionTimeMs: 1, pageCount, canonicalDocument,
    });
    const replaced = 4;
    const result = reconcileCanonicalArtifacts({
      canonicalDocument,
      extractionContract,
      replacements: [{
        pageNumber: replaced,
        markdown: [pages[replaced - 1]!.heading, ...pages[replaced - 1]!.lines].join("\n"),
        source: { adapter: "vision", model: "test", confidence: 0.9, confidenceBasis: "page-triage", reason: "test" },
      }],
    });
    // Oversized paragraphs split across chunks at a character limit, so compare without whitespace.
    const compact = (text: string) => text.replace(/\s+/g, "");
    const chunks = compact(buildCanonicalChunksFromDocument(result.canonicalDocument, "doc.pdf").map((chunk) => chunk.text).join(""));
    for (const page of pages) {
      expect(chunks).toContain(compact(page.heading));
      for (const line of page.lines) expect(chunks).toContain(compact(line));
    }
  }, 90_000);
});
