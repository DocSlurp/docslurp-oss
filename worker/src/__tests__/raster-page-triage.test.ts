import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ClassifyRouteStage, buildAdaptiveRoutingDecisionSurface } from "../stages/classify-route.js";
import { selectRasterPagesFromClassification } from "../stages/render-images.js";
import { VisionExtractStage } from "../stages/vision-extract.js";
import {
  buildPageImageEvidence,
  collectPageImageEvidence,
  summarizeImageListing,
  pageAlignedTexts,
  parsePdfImagesList,
  parsePdfPageAreas,
  type PageImageEvidence,
  type TextLayerVerifier,
} from "../lib/page-image-evidence.js";
import { collectPageLayoutFacts } from "../lib/page-layout-evidence.js";
import { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
import { VISION_ROUTING_VERSION_SLOT } from "../lib/vision-routing-v2.js";
import { splitFormFeedPages } from "../pipeline/page-facts.js";
import type { WorkflowState } from "../pipeline/pipeline.js";
import type { Document } from "../models.js";
import type { Config } from "../config.js";
import { CommandRunner } from "../tools/runner.js";
import type { ArtifactStore } from "../tools/storage.js";
import {
  PAGE_HEIGHT,
  PAGE_WIDTH,
  buildTestPdf,
  proseLines,
  scannedImage,
  solidImage,
  type TestPdfPage,
} from "../test/make-pdf.js";

const hasPoppler = (() => {
  try {
    execFileSync("pdfimages", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const textPage = (seed: number): TestPdfPage => ({ kind: "text", heading: `Section ${seed} harbor ledger review`, lines: proseLines(36, seed) });
const scanPage = (lines?: string[]): TestPdfPage => ({ kind: "image", images: [{ image: scannedImage() }], ...(lines ? { lines } : {}) });
const blankPage: TestPdfPage = { kind: "blank" };

interface Triage {
  evidence: PageImageEvidence[] | null;
  visionPages: number[];
  visionNeeded: boolean;
  reason: string;
  renderPages: number[];
}

describe.skipIf(!hasPoppler)("raster page triage on generated PDFs", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /** Text-layer extraction (poppler-text, the default host PDF extractor) → raster evidence → classification → vision and render selection. */
  async function triage(pages: TestPdfPage[], maxPagesPerDocument = 20, verifyTextLayer?: TextLayerVerifier, layout = false): Promise<Triage> {
    const dir = await mkdtemp(path.join(tmpdir(), "raster-triage-"));
    dirs.push(dir);
    const input = path.join(dir, "doc.pdf");
    await writeFile(input, buildTestPdf(pages));
    const runner = new CommandRunner();
    const markdown = (await runner.run(await runner.extractText(input, true))).stdout;

    const pageTexts = pageAlignedTexts(markdown, pages.length);
    expect(pageTexts, "extracted text should be page-aligned").not.toBeNull();
    // The PDF's own text layer, as page facts record it (one pdftotext run, form-feed split).
    const layerPlan = await runner.pageText(input, pages.length);
    const textLayerPages = splitFormFeedPages((await runner.run(layerPlan)).stdout, pages.length);
    const evidence = await collectPageImageEvidence({ runner, sourcePath: input, pageTexts: pageTexts!, textLayerPages, ...(verifyTextLayer ? { verifyTextLayer } : {}) });
    const evidenceMap = new Map((evidence ?? []).map((page) => [page.pageNumber, page]));
    // Local mode: the open layout walker in the parser sandbox, over the same extraction.
    const pageLayout = layout ? await collectPageLayoutFacts({ runner, sourcePath: input, pageCount: pages.length, markdown: pageTexts!.join("\f") }) : null;
    if (layout) expect(pageLayout, "layout facts should be collected").not.toBeNull();
    const surface = buildAdaptiveRoutingDecisionSurface({
      documentId: "doc-1",
      filename: "doc.pdf",
      text: markdown,
      pageCount: pages.length,
      evidence: markdown.trim()
        ? { source: "canonical-document", artifactUri: "s3://bucket/canonical.json" }
        : evidence
          ? { source: "page-image-evidence", artifactUri: "s3://bucket/evidence.json" }
          : null,
      pageImageEvidence: evidenceMap,
      ...(pageLayout ? { pageLayout } : {}),
      routingV2: true,
    });

    const storage = { bucket: "bucket", getJson: async () => surface } as unknown as ArtifactStore;
    const stage = new VisionExtractStage({} as CommandRunner, storage, { visionDensityThreshold: 0.25 } as Config, {} as never);
    const state = {
      artifactLedger: DocumentArtifactLedger.create({
        "doc-1:classification": "s3://bucket/classification.json",
        [VISION_ROUTING_VERSION_SLOT]: "v3",
      }),
      pendingPerformance: [],
      run: { pipeline: { quality: "auto", vision: {} } },
    } as unknown as WorkflowState;
    const decision = await (stage as unknown as {
      checkNeedsVision(document: Document, pageCount: number, state: WorkflowState): Promise<{ needed: boolean; selectedPages: number[]; reason: string }>;
    }).checkNeedsVision({ id: "doc-1", filename: "doc.pdf" } as Document, pages.length, state);
    return {
      evidence,
      visionPages: decision.selectedPages.slice(0, maxPagesPerDocument),
      visionNeeded: decision.needed,
      reason: decision.reason,
      renderPages: selectRasterPagesFromClassification(surface, { maxPages: maxPagesPerDocument, routingV2: true }),
    };
  }

  it("all native text: no raster evidence work and no vision", async () => {
    const result = await triage([textPage(1), textPage(2), textPage(3)]);
    expect(result.evidence).toBeNull();
    expect(result.visionNeeded).toBe(false);
    expect(result.visionPages).toEqual([]);
  }, 90_000);

  it("all scanned: every raster page goes to vision", async () => {
    const result = await triage([scanPage(), scanPage(), scanPage()]);
    expect(result.evidence?.map((page) => page.imageCount)).toEqual([1, 1, 1]);
    expect(result.visionPages).toEqual([1, 2, 3]);
  }, 90_000);

  it("mixed native and scanned pages: only the raster-only pages go to vision", async () => {
    const result = await triage([textPage(1), scanPage(), textPage(3), scanPage(), textPage(5)]);
    expect(result.reason).not.toBe("page-triage-skip");
    expect(result.visionPages).toEqual([2, 4]);
    expect(result.renderPages).toEqual([2, 4]);
  }, 90_000);

  it("a scan drawn as an inline image goes to vision", async () => {
    const result = await triage([textPage(1), { kind: "image", images: [{ image: scannedImage(), inline: true }] }, textPage(3)]);
    expect(result.evidence?.find((page) => page.pageNumber === 2)).toMatchObject({ imageCount: 1, largestImageCoverage: 1 });
    expect(result.visionPages).toEqual([2]);
  }, 90_000);

  it("near-empty native text over a full-page image goes to vision", async () => {
    const result = await triage([textPage(1), scanPage(["Ref 0042"]), textPage(3)]);
    const stamped = result.evidence?.find((page) => page.pageNumber === 2);
    expect(stamped?.wordCount).toBeGreaterThan(0);
    expect(stamped?.largestImageCoverage).toBeGreaterThan(0.95);
    expect(result.visionPages).toEqual([2]);
  }, 90_000);

  it("a scan placed with margins under a generated footer goes to vision; a captioned inset image does not", async () => {
    const inset = (scale: number, lines: string[]): TestPdfPage => ({
      kind: "image",
      images: [{ image: scannedImage(), rect: { x: (PAGE_WIDTH * (1 - scale)) / 2, y: (PAGE_HEIGHT * (1 - scale)) / 2, width: PAGE_WIDTH * scale, height: PAGE_HEIGHT * scale } }],
      lines,
    });
    const result = await triage([
      textPage(1),
      inset(0.8, ["Page 2 of 4"]), // ~64% of the page, a few footer words
      inset(0.55, ["Harbor cranes at dusk seen from the north pier during the spring survey season near the old granite quay"]), // ~30%, caption
      textPage(4),
    ]);
    expect(result.visionPages).toEqual([2]);
  }, 90_000);

  describe("with layout facts (owner rule 2026-11-05: a scan beside native text is read)", () => {
    const placed = (scale: number, lines: string[], image = scannedImage()): TestPdfPage => ({
      kind: "image",
      images: [{ image, rect: { x: (PAGE_WIDTH * (1 - scale)) / 2, y: 40, width: PAGE_WIDTH * scale, height: PAGE_HEIGHT * scale * 0.7 } }],
      lines,
    });
    const caption = proseLines(6, 4);

    it("a captioned scan covering a third of the page goes to vision; without layout facts it does not", async () => {
      const pages = [textPage(1), placed(0.7, caption), textPage(3)];
      expect((await triage(pages, 20, undefined, true)).visionPages).toEqual([2]);
      expect((await triage(pages)).visionPages).toEqual([]);
    }, 120_000);

    it("a small scan, a repeated letterhead, and an OCR'd scan with its text layer do not go to vision", async () => {
      const letterhead = { image: scannedImage({ width: 600, height: 400, lines: 8 }), rect: { x: 0, y: PAGE_HEIGHT * 0.6, width: PAGE_WIDTH, height: PAGE_HEIGHT * 0.4 }, shareKey: "letterhead" };
      const sheet = (seed: number): TestPdfPage => ({ kind: "image", images: [letterhead], lines: proseLines(8, seed) });
      expect((await triage([sheet(1), sheet(2), sheet(3), sheet(4)], 20, undefined, true)).visionPages).toEqual([]);
      expect((await triage([textPage(1), placed(0.3, caption), textPage(3)], 20, undefined, true)).visionPages).toEqual([]);
      expect((await triage([textPage(1), scanPage(proseLines(36, 9)), textPage(3)], 20, undefined, true)).visionPages).toEqual([]);
    }, 120_000);
  });

  it("blank pages never trigger paid vision, alone or in a document", async () => {
    const blankOnly = await triage([blankPage, blankPage]);
    expect(blankOnly.visionNeeded).toBe(false);
    expect(blankOnly.visionPages).toEqual([]);
    expect(blankOnly.renderPages).toEqual([]);

    const withBlanks = await triage([textPage(1), blankPage, scanPage(), blankPage]);
    expect(withBlanks.visionPages).toEqual([3]);
    expect(withBlanks.renderPages).toEqual([3]);
  }, 90_000);

  it("a dense text layer over a page image (OCR'd scan, designed page) does not go to vision", async () => {
    const result = await triage([textPage(1), scanPage(proseLines(36, 9)), textPage(3)]);
    expect(result.evidence).toBeNull();
    expect(result.visionPages).toEqual([]);
  }, 90_000);

  it("many tiny images (logos, tracking pixels, hostile PDFs) do not go to vision", async () => {
    const tiny = Array.from({ length: 400 }, (_, index) => ({
      image: solidImage(40, 40),
      rect: { x: (index % 20) * 30, y: Math.floor(index / 20) * 38, width: 8, height: 8 },
    }));
    const result = await triage([textPage(1), { kind: "image", images: tiny }, textPage(3)]);
    expect(result.evidence?.find((page) => page.pageNumber === 2)).toMatchObject({ imageCount: 0, imageCoverage: 0 });
    expect(result.visionPages).toEqual([]);
  }, 90_000);

  it("a logo or letterhead drawn on every page is page furniture, not a scan", async () => {
    // 3 words of text and a repeated image covering 40% of each page; a different image per page would be a scan.
    const letterhead = { image: scannedImage({ width: 600, height: 400, lines: 8 }), rect: { x: 0, y: 0, width: PAGE_WIDTH, height: PAGE_HEIGHT * 0.4 }, shareKey: "letterhead" };
    const sheet = (line: string): TestPdfPage => ({ kind: "image", images: [letterhead], lines: [line] });
    const result = await triage([sheet("Invoice 1001"), sheet("Invoice 1002"), sheet("Invoice 1003"), sheet("Invoice 1004")]);
    expect(result.evidence?.every((page) => page.imageCount === 0 && (page.repeatedImageCount ?? 0) === 1)).toBe(true);
    expect(result.visionPages).toEqual([]);
    expect(result.renderPages).toEqual([]);
  }, 90_000);

  it("a full-bleed slide background shared by every slide does not make titled slides scans", async () => {
    const background = { image: scannedImage({ width: 800, height: 600, lines: 4 }), shareKey: "slide-background" };
    const slide = (title: string): TestPdfPage => ({ kind: "image", images: [background], lines: [title] });
    const result = await triage([slide("Quarterly roadmap overview"), slide("Hiring plan for the spring"), slide("Risks and open questions"), slide("Thank you")]);
    expect(result.visionPages).toEqual([]);
  }, 90_000);

  it("a blank page carrying a 1x1 image is blank: never rendered, never read", async () => {
    const pixel: TestPdfPage = { kind: "image", images: [{ image: solidImage(1, 1, 255) }] };
    const result = await triage([textPage(1), pixel, textPage(3)]);
    expect(result.visionPages).toEqual([]);
    expect(result.renderPages).toEqual([]);
  }, 90_000);

  it("a scan beside repeated furniture is still read: only the repeated image is dropped", async () => {
    const logo = { image: solidImage(200, 200, 60), rect: { x: 20, y: PAGE_HEIGHT - 160, width: 140, height: 140 }, shareKey: "logo" };
    const page = (scan: boolean): TestPdfPage => ({ kind: "image", images: scan ? [logo, { image: scannedImage() }] : [logo], lines: scan ? [] : ["Quarterly update"] });
    const result = await triage([page(false), page(true), page(false), page(false)]);
    expect(result.visionPages).toEqual([2]);
  }, 90_000);

  it("a garbled text layer over a page image is read; the same page with a readable layer is not", async () => {
    const garbledLines = Array.from({ length: 20 }, (_, index) => `${index}KHPDWUL[SURGXFWFRPSDUHVHDFKTXHU\\ZLWK QRUPDOL]DWLRQ7KHUHVXOWLQJZHLJKWVDUHXVHG`);
    const pages: TestPdfPage[] = [textPage(1), { kind: "text", heading: "Garbled export", lines: garbledLines }, textPage(3)];
    // A glyph-code shift is suspect, not garbled: the OCR cross-check of the page image decides. (The generated PDF draws
    // the shifted text itself, so a real OCR would agree with it; the verifier stands in for a page that shows the
    // intended text.) Without a check the page is reported and not read.
    const unchecked = await triage(pages);
    expect(unchecked.evidence?.find((page) => page.pageNumber === 2)?.textLayer).toMatchObject({ verdict: "suspect", reasons: expect.arrayContaining(["glyph-shift"]) });
    expect(unchecked.visionPages).toEqual([]);
    const disagrees: TextLayerVerifier = async (checked) => new Map(checked.map((page) => [page.pageNumber, false]));
    const result = await triage(pages, 20, disagrees);
    expect(result.evidence?.find((page) => page.pageNumber === 2)?.textLayer).toMatchObject({ verdict: "suspect", matchesOcr: false });
    expect(result.visionPages).toEqual([2]);
  }, 90_000);

  it("a text page of prose that mentions photos, figures and percentages is not read", async () => {
    const prose = ["The photovoltaic paragraph 4(b) estimate rose 5% while the diagram figure and image captions stayed the same."];
    const result = await triage([textPage(1), { kind: "text", heading: "Photovoltaic output", lines: [...prose, ...proseLines(10, 4)] }, textPage(3)]);
    expect(result.visionPages).toEqual([]);
  }, 90_000);

  it("keeps raster-only pages first when the per-document vision budget truncates the selection", async () => {
    const result = await triage([textPage(1), scanPage(), scanPage(), scanPage(), scanPage(), scanPage(), scanPage()], 4);
    expect(result.visionPages).toEqual([2, 3, 4, 5]);
    expect(result.renderPages).toEqual([2, 3, 4, 5]);
  }, 90_000);
});

describe("page image evidence parsing", () => {
  it("measures placed image coverage and ignores masks and tiny or unplaced images", () => {
    const rowsText = [
      "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio",
      "--------------------------------------------------------------------------------------------",
      "   2     0 image    1275  1650  gray    1   8  image  no         8  0   150   150 31.6K 1.5%",
      "   2     1 smask    1275  1650  gray    1   8  image  no         9  0   150   150 31.6K 1.5%",
      "   3     2 image      16    16  gray    1   8  image  no        10  0    72    72   1K 1.5%",
      "   3     3 image     600   400  rgb     3   8  jpeg   no        11  0     0     0  10K 1.5%",
      "   3     4 image     300   200  rgb     3   8  jpeg   no        12  0   300   300  10K 1.5%",
      "garbage line",
    ].join("\n");
    const rows = parsePdfImagesList(rowsText);
    expect(rows.map((row) => [row.pageNumber, row.type])).toEqual([[2, "image"], [3, "image"], [3, "image"]]);
    const areas = parsePdfPageAreas("Page    2 size:  612 x 792 pts (letter)\nPage    3 size:  612 x 792 pts (letter)\n");
    const listing = summarizeImageListing(rowsText, { pageAreas: areas, pagesInScope: 4 });
    const evidence = buildPageImageEvidence({ sparsePages: new Map([[2, 0], [3, 4], [4, 0]]), listing });
    expect(evidence).toMatchObject([
      { pageNumber: 2, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1 },
      // 300x200 px at 300 ppi = 72x48 pt: under the significance floor (2% of the page).
      { pageNumber: 3, wordCount: 4, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0, anyImageCount: 2 },
      { pageNumber: 4, wordCount: 0, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0, anyImageCount: 0 },
    ]);
    expect(PAGE_WIDTH * PAGE_HEIGHT).toBe(612 * 792);
  });

  it("only trusts page-aligned text", () => {
    expect(pageAlignedTexts("", 3)).toEqual(["", "", ""]);
    expect(pageAlignedTexts("one page", 1)).toEqual(["one page"]);
    expect(pageAlignedTexts("alpha\f\fgamma", 3)).toEqual(["alpha", "", "gamma"]);
    expect(pageAlignedTexts("unpaged text over three pages", 3)).toBeNull();
    expect(pageAlignedTexts("alpha\fbravo", 3)).toBeNull();
  });

  it("classify-route loads persisted evidence and drops malformed entries", async () => {
    const storage = {
      bucket: "bucket",
      getJson: async () => ({
        pages: [
          { pageNumber: 2, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1 },
          { pageNumber: 0, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1 },
          { pageNumber: 3, wordCount: 0, imageCount: 1, imageCoverage: 7, largestImageCoverage: 1 },
          "junk",
        ],
      }),
    } as unknown as ArtifactStore;
    const state = {
      artifactLedger: DocumentArtifactLedger.create({ "doc-1:page-image-evidence": "s3://bucket/evidence.json" }),
    } as unknown as WorkflowState;
    const loaded = await (new ClassifyRouteStage(storage) as unknown as {
      loadPageImageEvidence(state: WorkflowState, documentId: string): Promise<{ pages: Map<number, PageImageEvidence> } | null>;
    }).loadPageImageEvidence(state, "doc-1");
    expect([...loaded!.pages.keys()]).toEqual([2]);
  });

  it("reuses a shared pdfimages listing that covers the sparse pages, and runs its own otherwise", async () => {
    const listing = [
      "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio",
      "   2     0 image    1275  1650  gray    1   8  image  no         8  0   150   150 31.6K 1.5%",
    ].join("\n");
    const calls: string[] = [];
    const runner = {
      listPdfImages: async () => ({ binary: "pdfimages", args: ["own"], available: true }),
      pdfPageSizes: async () => ({ binary: "pdfinfo", args: [], available: true }),
      run: async (plan: { binary: string; args: string[] }) => {
        calls.push(`${plan.binary}:${plan.args.join(" ")}`);
        return { stdout: plan.binary === "pdfinfo" ? "Page    2 size:  612 x 792 pts\n" : listing, stderr: "" };
      },
    } as unknown as CommandRunner;
    const pageTexts = ["plenty of native words ".repeat(20), ""];
    const shared = await collectPageImageEvidence({
      runner, sourcePath: "/x.pdf", pageTexts, sharedImagesList: { lastPage: 2, stdout: Promise.resolve(listing) },
    });
    expect(shared).toMatchObject([{ pageNumber: 2, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1, embeddedImageBytes: 32358 }]);
    expect(calls).toEqual(["pdfinfo:"]);

    calls.length = 0;
    await collectPageImageEvidence({ runner, sourcePath: "/x.pdf", pageTexts, sharedImagesList: { lastPage: 1, stdout: Promise.resolve(listing) } });
    await collectPageImageEvidence({ runner, sourcePath: "/x.pdf", pageTexts, sharedImagesList: { lastPage: 2, stdout: Promise.resolve(null) } });
    expect(calls).toEqual(["pdfimages:own", "pdfinfo:", "pdfimages:own", "pdfinfo:"]);
  });

  it("reads inline images, whose object column is one `[inline]` token", () => {
    // Verbatim poppler 26.10 output for a page drawn with BI … ID … EI.
    const rows = parsePdfImagesList("   1     0 image      40   100  gray    1   8  image  no   [inline]       5     9 4000B 100%");
    expect(rows).toEqual([{ pageNumber: 1, type: "image", width: 40, height: 100, xPpi: 5, yPpi: 9, objectKey: null }]);
    // An image object poppler cannot reference (reconstructed xref, out-of-range generation) prints `[none]`.
    expect(parsePdfImagesList("   1     0 image      40   100  gray    1   8  image  no   [none]       5     9 4001B 100%")).toHaveLength(1);
  });

  it("folds a hostile listing into per-page totals: 150,000 tiny images on page 1 cannot hide the scan on page 3", () => {
    const row = (page: number, num: number, size: number, ppi: number, object: number) =>
      `   ${page}  ${num} image  ${size}  ${size}  gray  1  8  image  no  ${object}  0  ${ppi}  ${ppi}  1K 1%`;
    const lines = Array.from({ length: 150_000 }, (_, index) => row(1, index, 40, 72, 1000 + index));
    lines.push("   3  0 image  1275  1650  gray  1  8  image  no  9  0  150  150  1K 1%");
    const areas = new Map([[1, 612 * 792], [3, 612 * 792]]);
    const summary = summarizeImageListing(lines.join("\n"), { pageAreas: areas, pagesInScope: 3 });
    expect(summary.truncatedAfterPage).toBeNull();
    expect(summary.pages.get(1)).toMatchObject({ anyImageCount: 150_000, imageCount: 0 });
    expect(summary.pages.get(3)).toMatchObject({ imageCount: 1, largestImageCoverage: 1 });
  });

  it("marks pages after a listing that is too long as unknown, never as having no images", () => {
    const row = (page: number, object: number) => `   ${page}  0 image  1275  1650  gray  1  8  image  no  ${object}  0  150  150  1K 1%`;
    const lines = [row(1, 1), row(1, 2), row(2, 3), row(2, 4), row(3, 5), row(3, 6)];
    const summary = summarizeImageListing(lines.join("\n"), { pageAreas: new Map(), defaultPageArea: 612 * 792, pagesInScope: 3, maxLines: 4 });
    expect(summary.truncatedAfterPage).toBe(1);
    const evidence = buildPageImageEvidence({ sparsePages: new Map([[1, 0], [2, 0], [3, 0]]), listing: summary });
    expect(evidence.map((page) => [page.pageNumber, page.imagesKnown])).toEqual([[1, true], [2, false], [3, false]]);
  });

  it("detects an image drawn on at least three pages and a fifth of them as furniture, and nothing less", () => {
    const row = (page: number, object: number) => `   ${page}  0 image  1275  1650  gray  1  8  image  no  ${object}  0  150  150  1K 1%`;
    const furniture = summarizeImageListing([1, 2, 3, 4, 5].map((page) => row(page, 7)).join("\n"), { pageAreas: new Map(), defaultPageArea: 612 * 792, pagesInScope: 5 });
    expect(furniture.pages.get(2)).toMatchObject({ imageCount: 0, repeatedImageCount: 1 });
    // two scans of the same object (a duplicated page) stay scans; three of 100 pages are not a fifth
    const twice = summarizeImageListing([row(1, 7), row(2, 7)].join("\n"), { pageAreas: new Map(), defaultPageArea: 612 * 792, pagesInScope: 2 });
    expect(twice.pages.get(1)).toMatchObject({ imageCount: 1, repeatedImageCount: 0 });
    const sparseShare = summarizeImageListing([row(1, 7), row(2, 7), row(3, 7)].join("\n"), { pageAreas: new Map(), defaultPageArea: 612 * 792, pagesInScope: 100 });
    expect(sparseShare.pages.get(1)).toMatchObject({ imageCount: 1, repeatedImageCount: 0 });
  });

  it("caps the rows parsed from a hostile image list", () => {
    const line = "   1     0 image    100  100  gray    1   8  image  no         8  0   72   72 1K 1%";
    expect(parsePdfImagesList(Array.from({ length: 50 }, () => line).join("\n"), 10)).toHaveLength(10);
  });
});
