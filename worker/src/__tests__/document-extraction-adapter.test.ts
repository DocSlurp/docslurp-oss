import { describe, expect, it } from "vitest";

import { parseDocumentExtractionResult } from "../lib/document-extraction-adapter.js";

describe("parseDocumentExtractionResult", () => {
  it("accepts one-pass structured page evidence", () => {
    const result = parseDocumentExtractionResult({
      adapter: "liteparse",
      version: "2.6.0",
      markdown: "# Title",
      rawText: "Title",
      pages: [
        {
          pageNumber: 1,
          width: 612,
          height: 792,
          text: "Title",
          markdown: "# Title",
          textItems: [
            {
              text: "Title",
              x: 10,
              y: 20,
              width: 30,
              height: 10,
              words: [],
            },
          ],
          complexity: {
            textLength: 5,
            textCoverage: 0.01,
            hasSubstantialImages: false,
            imageBlockCount: 0,
            imageCoverage: 0,
            largestImageCoverage: 0,
            fullPageImage: false,
            isGarbled: false,
            pageArea: 484704,
            needsOcr: false,
            reasons: [],
          },
        },
      ],
      diagnostics: { latencyMs: 2.5, ocrEnabled: false },
    });

    expect(result.pages[0]!.textItems[0]).toMatchObject({
      text: "Title",
      x: 10,
      y: 20,
    });
    expect(result.pages[0]!.complexity?.needsOcr).toBe(false);
  });

  it("rejects incomplete helper output", () => {
    expect(() => parseDocumentExtractionResult({ markdown: "missing" })).toThrow(
      "invalid result",
    );
  });
});
