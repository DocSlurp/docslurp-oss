import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "node:path";
import { CommandRunner } from "../tools/runner.js";
import { benchmarkExtractor } from "../benchmarks/extraction-benchmark.js";
import { buildExtractionContract } from "../lib/extraction-contract.js";
import { loadNativePdfEngine } from "../native-pdf/loader.js";

// Pipe tables come from the private native-pdf engine; Kreuzberg renders this fixture's tables as aligned text.
const nativePdfAvailable = (await loadNativePdfEngine()).ok;

describe("Extraction Edge Cases", () => {
  let runner: CommandRunner;

  beforeAll(() => {
    runner = new CommandRunner();
  });

  afterAll(async () => {
    await runner.close();
  });

  it.skipIf(!nativePdfAvailable)("extracts multipage tables correctly", async () => {
    const fixturePath = path.resolve(
      process.cwd(),
      "testdata/pdf-fixtures/tables-multipage-financials.pdf",
    );
    try {
      const result = await benchmarkExtractor({
        fixtureId: "tables-multipage",
        fixturePath,
        method: "native-pdf",
        runner,
      });

      expect(result.contract.markdown).toContain("|"); // Check for table syntax
      expect(result.contract.metadata.extractor).toBe("native-pdf");
      expect(result.contract.metadata.plausibilityScore).toBeGreaterThan(0);

      // Often financial tables contain numbers like "2025", let's check for it in rawText
      expect(result.contract.rawText).toContain("2025");

      console.log(`Multipage Tables - Plausibility: ${result.plausibilityScore}`);
    } catch (e: any) {
      if (e.code === "ENOENT" || e.message.includes("no such file")) {
        console.warn("Skipping benchmark: fixture not found");
      } else {
        throw e;
      }
    }
  }, 30000);

  it("detects formulas and LaTeX correctly", async () => {
    const fixturePath = path.resolve(
      process.cwd(),
      "testdata/pdf-fixtures/kreuzberg-formulas-math.pdf",
    );
    try {
      const result = await benchmarkExtractor({
        fixtureId: "formulas-math",
        fixturePath,
        method: "kreuzberg",
        runner,
      });

      expect(result.contract.metadata.extractor).toBe("kreuzberg");
      // the extractor keeps the raw text for these formulas, which include "integral", "derivative"
      expect(result.contract.markdown.toLowerCase()).toContain("integral");
      expect(result.contract.markdown.toLowerCase()).toContain("derivative");

      console.log(`Formulas/Math - Plausibility: ${result.plausibilityScore}`);
    } catch (e: any) {
      if (e.code === "ENOENT" || e.message.includes("no such file")) {
        console.warn("Skipping benchmark: fixture not found");
      } else {
        throw e;
      }
    }
  }, 30000);

  it("extracts and parses complex multi-column figure reports", async () => {
    const fixturePath = path.resolve(
      process.cwd(),
      "testdata/pdf-fixtures/multicolumn-figures-report.pdf",
    );
    try {
      const result = await benchmarkExtractor({
        fixtureId: "multicolumn-report",
        fixturePath,
        method: "kreuzberg",
        runner,
      });

      expect(result.contract.metadata.extractor).toBe("kreuzberg");
      // Multi-column logic might get mangled but should be mostly present
      expect(result.contract.rawText.toLowerCase()).toContain("figure 2");
      expect(result.contract.rawText.toLowerCase()).toContain("latency");

      console.log(`Multi-column - Plausibility: ${result.plausibilityScore}`);
    } catch (e: any) {
      if (e.code === "ENOENT" || e.message.includes("no such file")) {
        console.warn("Skipping benchmark: fixture not found");
      } else {
        throw e;
      }
    }
  }, 30000);

  it("extracts from metadata-rich documents and images", async () => {
    const fixturePath = path.resolve(
      process.cwd(),
      "testdata/pdf-fixtures/kreuzberg-metadata-document.pdf",
    );
    try {
      const result = await benchmarkExtractor({
        fixtureId: "metadata-doc",
        fixturePath,
        method: "kreuzberg",
        runner,
      });

      expect(result.contract.metadata.extractor).toBe("kreuzberg");
      expect(result.contract.rawText.toLowerCase()).toContain("title");
      expect(result.contract.rawText.toLowerCase()).toContain("author");

      console.log(`Metadata Document - Plausibility: ${result.plausibilityScore}`);
    } catch (e: any) {
      if (e.code === "ENOENT" || e.message.includes("no such file")) {
        console.warn("Skipping benchmark: fixture not found");
      } else {
        throw e;
      }
    }
  }, 30000);

  it("handles ad-hoc combination of pages from different source files correctly", async () => {
    // Generate a mock contract for the combined pages scenario
    const markdownFile1 = `
# Source File 1: Math Docs
Some text explaining derivatives.
$$ \\frac{d}{dx} x^2 = 2x $$
[Math Link](http://example.com/math)
    `.trim();

    const markdownFile2 = `
# Source File 2: Financials
| Q1 | Q2 |
|---|---|
| 100 | 200 |

Here is a code snippet:
\`\`\`python
print("Hello World")
\`\`\`
    `.trim();

    // Use form feed character \f to separate pages
    const combinedMarkdown = markdownFile1 + "\n\f\n" + markdownFile2;

    const contract = buildExtractionContract({
      documentId: "combined-doc",
      markdown: combinedMarkdown,
      extractor: "mock-combiner",
      strategy: "combined",
      extractionTimeMs: 150,
      pageCount: 2,
    });

    expect(contract.documentId).toBe("combined-doc");

    // Check that features from BOTH files are detected
    expect(contract.hasLaTeX).toBe(true);
    expect(contract.hasCode).toBe(true);

    // Check that structure spans the combined output
    expect(contract.headers.length).toBeGreaterThanOrEqual(2);
    expect(contract.headers[0].text).toContain("Source File 1");
    expect(contract.headers[1].text).toContain("Source File 2");

    // Check links
    expect(contract.links.length).toBe(1);
    expect(contract.links[0].url).toBe("http://example.com/math");

    // Ensure raw text stripped markdown chars correctly
    expect(contract.rawText).toContain("Source File 1: Math Docs");
    expect(contract.rawText).toContain('print("Hello World")');

    // Pages structure - chunkCount should be exactly 2 because we merged 2 pages with \f
    expect(contract.metadata.chunkCount).toBe(2);
    expect(contract.metadata.tokenCount).toBeGreaterThan(10);
  });

  it("can build extraction contract properly using canonical document table structure", async () => {
    // Test that the buildExtractionContract prefers canonical document structure when available
    const contract = buildExtractionContract({
      documentId: "doc-with-canonical",
      markdown: "Table below:\n| A | B |\n| 1 | 2 |",
      extractor: "test-extractor",
      strategy: "test-strategy",
      extractionTimeMs: 100,
      pageCount: 1,
      canonicalDocument: {
        documentId: "doc-with-canonical",
        generator: "test",
        source: {
          format: "markdown",
          extractor: "test-extractor",
          artifactUri: null,
          parser: "native-pdf",
          parserArtifactUri: null,
        },
        stats: {
          blockCount: 1,
          headingCount: 0,
          paragraphCount: 0,
          codeBlockCount: 0,
          tableCount: 1,
          pageCount: 1,
        },
        blocks: [
          {
            id: "table-1",
            type: "table",
            order: 0,
            text: "| A | B |\n| 1 | 2 |",
            headingPath: [],
            pageNumber: 1,
            lineStart: 2,
            lineEnd: 3,
            bbox: { x: 10, y: 20, width: 100, height: 50 },
            metadata: {
              rowCount: 2,
              colCount: 2,
              polygon: [
                { x: 10, y: 20 },
                { x: 110, y: 20 },
                { x: 110, y: 70 },
                { x: 10, y: 70 },
              ],
            },
          },
        ],
      },
    });

    expect(contract.tables).toHaveLength(1);
    expect(contract.tables[0].rowCount).toBe(2);
    expect(contract.tables[0].colCount).toBe(2);
    expect(contract.tables[0].bbox).toBeDefined();
    expect(contract.tables[0].bbox?.width).toBe(100);
    expect(contract.tables[0].bbox?.polygon).toHaveLength(4);
  });

  it("detects ToC and QR codes correctly from markdown", async () => {
    const markdown = `
# Table of Contents
1. Intro
2. QR Code info
Scan the QR code below:
![QR Code](qr.png)
    `.trim();

    const contract = buildExtractionContract({
      documentId: "toc-qr",
      markdown,
      extractor: "mock",
      strategy: "mock",
      extractionTimeMs: 10,
      pageCount: 1,
    });

    expect(contract.hasToC).toBe(true);
    expect(contract.hasQRCodes).toBe(true);
    expect(contract.headers[0].text).toBe("Table of Contents");
  });
});
