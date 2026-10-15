import { describe, it, expect } from "vitest";
import {
  buildAdaptivePageRoutes,
  buildAdaptiveRoutingDecisionSurface,
  authorizeStructuredOcr,
  classifyAdaptivePage,
  classifyTextAndFilename,
  resolveAdaptivePlaybook,
  suggestPlaybook,
  summarizeSpecializedContent,
  summarizeAdaptiveRouting
} from "../stages/classify-route.js";

describe("classifyTextAndFilename", () => {
  it("defers first-run routing until extraction evidence exists", () => {
    expect(
      buildAdaptiveRoutingDecisionSurface({
        documentId: "doc-first-run",
        filename: "scan.pdf",
        text: "",
        pageCount: 2,
        evidence: null,
      }),
    ).toEqual({
      status: "deferred",
      documentId: "doc-first-run",
      reason: "extraction-evidence-unavailable",
      pages: [],
    });
  });

  it("treats no-text LiteParse complexity as valid first-run routing evidence", () => {
    const surface = buildAdaptiveRoutingDecisionSurface({
      documentId: "doc-scan",
      filename: "scan.pdf",
      text: "",
      pageCount: 1,
      evidence: {
        source: "liteparse-structured",
        artifactUri: "s3://bucket/scan.structured.json",
      },
      structuredComplexity: new Map([
        [
          1,
          {
            textLength: 0,
            textCoverage: 0,
            hasSubstantialImages: true,
            imageCoverage: 0.96,
            largestImageCoverage: 0.96,
            fullPageImage: true,
            uncoveredVectorArea: 0,
            isGarbled: false,
            pageArea: 100_000,
            needsOcr: true,
            reasons: ["no-text", "full-page-image"],
          },
        ],
      ]),
    });

    expect(surface.status).toBe("ready");
    if (surface.status === "ready") {
      expect(surface.evidence.source).toBe("liteparse-structured");
      expect(surface.pages[0]).toMatchObject({
        pageNumber: 1,
        route: "handwriting-or-degraded",
        extractorHint: "vision-rescue",
        ocrDecision: { authorized: true },
      });
    }
  });

  it("detects invoice", () => {
    const { label, confidence } = classifyTextAndFilename("Invoice #123\nSubtotal $10\nRemit to...", "Q1-invoice.pdf");
    expect(label).toBe("invoice");
    expect(confidence).toBeGreaterThan(0.8);
  });

  it("detects contract", () => {
    const { label } = classifyTextAndFilename("This Agreement is made between the Parties...", "msa.pdf");
    expect(label).toBe("contract");
  });

  it("does not classify prose about metadata fields as a form", () => {
    const { label } = classifyTextAndFilename(
      "Parsers should expose metadata fields separately from body text content.",
      "extraction-report.pdf",
    );
    expect(label).toBe("generic");
  });

  it("classifies dense prose pages as straightforward text", () => {
    const pages = buildAdaptivePageRoutes(
      "This is a dense paragraph with several complete sentences and enough words to look like normal prose on a page.",
      1
    );
    expect(pages[0]?.route).toBe("straightforward-text");
    expect(pages[0]?.extractorHint).toBe("cheap-text");
  });

  it("classifies form-heavy pages for layout-aware routing", () => {
    const pages = buildAdaptivePageRoutes(
      "Name: __________\nAddress: __________\nDate: __________\nSignature: __________",
      1
    );
    expect(pages[0]?.route).toBe("form");
    expect(pages[0]?.extractorHint).toBe("layout-aware");
  });

  it("marks degraded low-text pages for vision rescue", () => {
    const pages = buildAdaptivePageRoutes("� � \n* *\n12", 1);
    expect(pages[0]?.route).toBe("handwriting-or-degraded");
    expect(pages[0]?.extractorHint).toBe("vision-rescue");
  });

  it("routes formula-heavy pages to syntax-preserving extraction", () => {
    const page = classifyAdaptivePage(
      1,
      "\\begin{equation}\nE = mc^2\nf(x) = x^2 + 4x + 4\n\\end{equation}\nThe limit uses \\frac{1}{n}."
    );

    expect(page.route).toBe("formula-heavy");
    expect(page.extractorHint).toBe("syntax-preserving");
    expect(page.specializedContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "formula"
        })
      ])
    );
  });

  it("routes code-heavy pages to syntax-preserving extraction", () => {
    const page = classifyAdaptivePage(
      1,
      "```ts\nexport async function loadUser(id: string) {\n  const user = await db.users.findById(id);\n  return user;\n}\n```"
    );

    expect(page.route).toBe("code-heavy");
    expect(page.extractorHint).toBe("syntax-preserving");
    expect(page.specializedContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "source-code"
        })
      ])
    );
  });

  it("does not mistake Markdown headings and prose keywords for source code", () => {
    const page = classifyAdaptivePage(
      1,
      "# Meeting Notes\n\nThe following review was exported from the image.\n\n## Action items",
    );

    expect(page.route).not.toBe("code-heavy");
    expect(page.specializedContent).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "source-code" })]),
    );
  });

  it("prefers formula routing for fenced LaTeX rather than treating it as code", () => {
    const page = classifyAdaptivePage(
      1,
      "# Method\n\nThe following derivation describes the normalized objective used by the research team.\n\n```\nE[f(X)] = \\int_0^\\infty x^2 dx\n\\frac{d}{dx} f(x) = x^2 + 4x\n```\n\nThe coefficient remains stable across the complete evaluation sample.",
    );

    expect(page.route).toBe("formula-heavy");
    expect(page.extractorHint).toBe("syntax-preserving");
  });

  it("recognizes Markdown tables without requiring chart-like terms", () => {
    const page = classifyAdaptivePage(
      1,
      "| Region | Product | Q1 | Q2 |\n|---|---|---|---|\n| North | Crawler | 120 | 124 |",
    );

    expect(page.route).toBe("table-heavy");
    expect(page.extractorHint).toBe("layout-aware");
  });

  it("recognizes extracted form fields expressed as Markdown headings", () => {
    const page = classifyAdaptivePage(
      1,
      "# Intake Form\n\nComplete every field before submitting this intake record for review.\n\n## Case ID\n\n## Submitted by\n\n## Preferred contact method\n\nThe reviewer will verify these details before processing the request.",
    );

    expect(page.route).toBe("form");
    expect(page.extractorHint).toBe("layout-aware");
  });

  it("routes chemistry-heavy pages to syntax-preserving extraction", () => {
    const page = classifyAdaptivePage(
      1,
      "Reaction: 2 H2 + O2 -> 2 H2O\nSolvent: DMSO\n1H NMR (400 MHz) shows peaks at 7.2 ppm."
    );

    expect(page.route).toBe("chemical-notation-heavy");
    expect(page.extractorHint).toBe("syntax-preserving");
    expect(page.specializedContent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "chemical-notation"
        })
      ])
    );
  });

  it("summarizes specialized routing kinds across pages", () => {
    const pages = [
      classifyAdaptivePage(1, "E = mc^2\n\\sum_{i=1}^{n} i"),
      classifyAdaptivePage(2, "function add(a, b) {\n  return a + b;\n}"),
      classifyAdaptivePage(3, "NaCl + AgNO3 -> AgCl + NaNO3\npH 7.2")
    ];

    expect(summarizeSpecializedContent(pages)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "formula",
          pageCount: 1,
          pageNumbers: [1]
        }),
        expect.objectContaining({
          kind: "source-code",
          pageCount: 1,
          pageNumbers: [2]
        }),
        expect.objectContaining({
          kind: "chemical-notation",
          pageCount: 1,
          pageNumbers: [3]
        })
      ])
    );
  });
});

describe("structured OCR authorization", () => {
  const baseComplexity = {
    textLength: 42,
    textCoverage: 0.03,
    hasSubstantialImages: false,
    imageCoverage: 0,
    largestImageCoverage: 0,
    fullPageImage: false,
    uncoveredVectorArea: 0,
    isGarbled: false,
    pageArea: 100_000,
    needsOcr: true,
    reasons: [] as string[],
  };

  it("does not authorize OCR for a clean short invoice marked only sparse", () => {
    expect(
      authorizeStructuredOcr(
        { ...baseComplexity, reasons: ["sparse-text"] },
        "Invoice #1042\nTotal: $42.00",
      ),
    ).toMatchObject({ authorized: false });
  });

  it("does not authorize OCR for a clean logo page with an embedded image", () => {
    expect(
      authorizeStructuredOcr(
        {
          ...baseComplexity,
          hasSubstantialImages: true,
          imageCoverage: 0.2,
          largestImageCoverage: 0.2,
          reasons: ["embedded-images"],
        },
        "Acme Corporation",
      ),
    ).toMatchObject({ authorized: false });
  });

  it("authorizes OCR for a no-text scan or full-page image", () => {
    // LiteParse marks a raster-only page "scanned" with a full-page image.
    expect(
      authorizeStructuredOcr(
        { ...baseComplexity, textLength: 0, fullPageImage: true, reasons: ["scanned"] },
        "",
      ),
    ).toMatchObject({ authorized: true, signals: ["ocr-authorized:no-native-text"] });
    expect(
      authorizeStructuredOcr(
        {
          ...baseComplexity,
          fullPageImage: true,
          largestImageCoverage: 0.94,
          reasons: ["embedded-images"],
        },
        "Acme",
      ),
    ).toMatchObject({ authorized: true });
  });

  it("does not authorize OCR for a blank page (no native text, nothing drawn)", () => {
    // LiteParse marks a blank page "no-text" with no image or vector content.
    expect(
      authorizeStructuredOcr({ ...baseComplexity, textLength: 0, reasons: ["no-text"] }, ""),
    ).toMatchObject({ authorized: false, signals: ["ocr-not-authorized:blank-page"] });
    // Raster evidence from the PDF itself can still show image content LiteParse missed.
    expect(
      authorizeStructuredOcr({ ...baseComplexity, textLength: 0, reasons: ["no-text"] }, "", {
        pageNumber: 1, wordCount: 0, imageCount: 1, imageCoverage: 0.6, largestImageCoverage: 0.6,
      }),
    ).toMatchObject({ authorized: true });
  });

  it("authorizes OCR when normalized page text is empty despite parser footer text", () => {
    expect(
      authorizeStructuredOcr(
        {
          ...baseComplexity,
          textLength: 29,
          hasSubstantialImages: true,
          imageCoverage: 0.67,
          largestImageCoverage: 0.67,
          reasons: ["sparse-text", "embedded-images"],
        },
        "",
      ),
    ).toMatchObject({
      authorized: true,
      signals: ["ocr-authorized:no-native-text"],
    });
  });

  it("authorizes OCR for a substantial raster region with sparse native text", () => {
    expect(
      authorizeStructuredOcr(
        {
          ...baseComplexity,
          hasSubstantialImages: true,
          imageCoverage: 0.42,
          largestImageCoverage: 0.42,
          reasons: ["sparse-text", "embedded-images"],
        },
        "Meeting notes with a scanned handwritten region.",
      ),
    ).toMatchObject({
      authorized: true,
      signals: ["ocr-authorized:substantial-raster-with-sparse-text"],
    });
  });

  it("requires plausibility failure before garble or uncovered-vector evidence authorizes OCR", () => {
    const complexity = {
      ...baseComplexity,
      isGarbled: true,
      uncoveredVectorArea: 10_000,
      reasons: ["garbled-text", "uncovered-vector-text"],
    };
    expect(authorizeStructuredOcr(complexity, "Quarterly revenue was $42.00.")).toMatchObject({
      authorized: false,
    });
    expect(authorizeStructuredOcr(complexity, "�� @@ xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).toMatchObject({
      authorized: true,
    });
  });
});

describe("suggestPlaybook", () => {
  it("maps invoice to layout-aware", () => {
    expect(suggestPlaybook("invoice")).toBe("layout-aware");
  });
  it("maps default to null", () => {
    expect(suggestPlaybook("generic")).toBeNull();
  });

  it("escalates generic complex routing to review-grade when degraded pages dominate", () => {
    const pages = buildAdaptivePageRoutes("� � \n* *\n12\fReadable prose follows with enough content.", 2);
    const summary = summarizeAdaptiveRouting(pages);
    expect(summary.documentComplexity).toBe("complex");
    expect(summary.visionPolicy).toBe("aggressive");
    expect(
      resolveAdaptivePlaybook({
        label: "generic",
        documentComplexity: summary.documentComplexity,
        dominantRoutes: summary.dominantRoutes
      })
    ).toBe("review-grade");
  });

  it("routes specialized notation pages to the agentic playbook", () => {
    const pages = buildAdaptivePageRoutes("const total = rows.reduce((sum, row) => sum + row.value, 0);", 1);
    const summary = summarizeAdaptiveRouting(pages);

    expect(
      resolveAdaptivePlaybook({
        label: "generic",
        documentComplexity: summary.documentComplexity,
        dominantRoutes: summary.dominantRoutes
      })
    ).toBe("agentic");
  });
});
