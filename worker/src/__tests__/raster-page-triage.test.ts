import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

import { ClassifyRouteStage, buildAdaptiveRoutingDecisionSurface } from "../stages/classify-route.js";
import { selectRasterPagesFromClassification } from "../stages/render-images.js";
import { VisionExtractStage } from "../stages/vision-extract.js";
import {
  buildPageImageEvidence,
  collectPageImageEvidence,
  pageAlignedTexts,
  parsePdfImagesList,
  parsePdfPageAreas,
  type PageImageEvidence,
} from "../lib/page-image-evidence.js";
import { DocumentArtifactLedger } from "../pipeline/artifact-ledger.js";
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

const kreuzbergScript = fileURLToPath(new URL("../../scripts/kreuzberg_extract.mjs", import.meta.url));

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

  /** Kreuzberg extraction → raster evidence → classification → vision and render selection. */
  async function triage(pages: TestPdfPage[], maxPagesPerDocument = 20): Promise<Triage> {
    const dir = await mkdtemp(path.join(tmpdir(), "raster-triage-"));
    dirs.push(dir);
    const input = path.join(dir, "doc.pdf");
    const output = path.join(dir, "doc.md");
    await writeFile(input, buildTestPdf(pages));
    await promisify(execFile)(process.execPath, [kreuzbergScript, "--input", input, "--output", output], { timeout: 60_000 });
    const markdown = await readFile(output, "utf8");

    const pageTexts = pageAlignedTexts(markdown, pages.length);
    expect(pageTexts, "Kreuzberg Markdown should be page-aligned").not.toBeNull();
    const evidence = await collectPageImageEvidence({ runner: new CommandRunner(), sourcePath: input, pageTexts: pageTexts! });
    const evidenceMap = new Map((evidence ?? []).map((page) => [page.pageNumber, page]));
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
    });

    const storage = { bucket: "bucket", getJson: async () => surface } as unknown as ArtifactStore;
    const stage = new VisionExtractStage({} as CommandRunner, storage, { visionDensityThreshold: 0.25 } as Config, {} as never);
    const state = {
      artifactLedger: DocumentArtifactLedger.create({ "doc-1:classification": "s3://bucket/classification.json" }),
      pendingPerformance: [],
      run: { pipeline: { vision: { forceAllPages: false, maxPagesPerDocument } } },
    } as unknown as WorkflowState;
    const decision = await (stage as unknown as {
      checkNeedsVision(document: Document, pageCount: number, state: WorkflowState): Promise<{ needed: boolean; selectedPages: number[]; reason: string }>;
    }).checkNeedsVision({ id: "doc-1", filename: "doc.pdf" } as Document, pages.length, state);
    return {
      evidence,
      visionPages: decision.selectedPages.slice(0, maxPagesPerDocument),
      visionNeeded: decision.needed,
      reason: decision.reason,
      renderPages: selectRasterPagesFromClassification(surface, { maxPages: maxPagesPerDocument }),
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

  it("keeps raster-only pages first when the per-document vision budget truncates the selection", async () => {
    const result = await triage([textPage(1), scanPage(), scanPage(), scanPage(), scanPage(), scanPage(), scanPage()], 4);
    expect(result.visionPages).toEqual([2, 3, 4, 5]);
    expect(result.renderPages).toEqual([2, 3, 4, 5]);
  }, 90_000);
});

describe("page image evidence parsing", () => {
  it("measures placed image coverage and ignores masks and tiny or unplaced images", () => {
    const rows = parsePdfImagesList([
      "page   num  type   width height color comp bpc  enc interp  object ID x-ppi y-ppi size ratio",
      "--------------------------------------------------------------------------------------------",
      "   2     0 image    1275  1650  gray    1   8  image  no         8  0   150   150 31.6K 1.5%",
      "   2     1 smask    1275  1650  gray    1   8  image  no         9  0   150   150 31.6K 1.5%",
      "   3     2 image      16    16  gray    1   8  image  no        10  0    72    72   1K 1.5%",
      "   3     3 image     600   400  rgb     3   8  jpeg   no        11  0     0     0  10K 1.5%",
      "   3     4 image     300   200  rgb     3   8  jpeg   no        12  0   300   300  10K 1.5%",
      "garbage line",
    ].join("\n"));
    expect(rows.map((row) => [row.pageNumber, row.type])).toEqual([[2, "image"], [3, "image"], [3, "image"]]);
    const areas = parsePdfPageAreas("Page    2 size:  612 x 792 pts (letter)\nPage    3 size:  612 x 792 pts (letter)\n");
    const evidence = buildPageImageEvidence({ sparsePages: new Map([[2, 0], [3, 4], [4, 0]]), images: rows, pageAreas: areas });
    expect(evidence).toEqual([
      { pageNumber: 2, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1 },
      // 300x200 px at 300 ppi = 72x48 pt: under the significance floor (2% of the page).
      { pageNumber: 3, wordCount: 4, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 },
      { pageNumber: 4, wordCount: 0, imageCount: 0, imageCoverage: 0, largestImageCoverage: 0 },
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
    expect(shared).toEqual([{ pageNumber: 2, wordCount: 0, imageCount: 1, imageCoverage: 1, largestImageCoverage: 1 }]);
    expect(calls).toEqual(["pdfinfo:"]);

    calls.length = 0;
    await collectPageImageEvidence({ runner, sourcePath: "/x.pdf", pageTexts, sharedImagesList: { lastPage: 1, stdout: Promise.resolve(listing) } });
    await collectPageImageEvidence({ runner, sourcePath: "/x.pdf", pageTexts, sharedImagesList: { lastPage: 2, stdout: Promise.resolve(null) } });
    expect(calls).toEqual(["pdfimages:own", "pdfinfo:", "pdfimages:own", "pdfinfo:"]);
  });

  it("caps the rows parsed from a hostile image list", () => {
    const line = "   1     0 image    100  100  gray    1   8  image  no         8  0   72   72 1K 1%";
    expect(parsePdfImagesList(Array.from({ length: 50 }, () => line).join("\n"), 10)).toHaveLength(10);
  });
});
