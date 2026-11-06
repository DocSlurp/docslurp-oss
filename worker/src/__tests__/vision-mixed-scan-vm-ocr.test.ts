import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPipelineFeatures, MIXED_SCAN_IMAGE_SIGNAL } from "@docslurp/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const ocr = vi.hoisted(() => ({ calls: [] as Array<{ pages: number[]; kind: string; source: string }>, mode: "read" as "read" | "refuse" | "infra" }));
vi.mock("../ocr/read-document.js", () => ({
  ocrDocument: async (args: { pages: number[]; kind: string; source: string }) => {
    ocr.calls.push({ pages: [...args.pages], kind: args.kind, source: args.source });
    if (ocr.mode === "refuse") throw new Error("vm ocr: input refused (decode-failed)");
    if (ocr.mode === "infra") {
      const { OcrInfrastructureError } = await import("../ocr/mode.js");
      throw new OcrInfrastructureError("VM creation failed");
    }
    return { pages: args.pages.map((pageNumber) => ({ pageNumber, text: `OCR page ${pageNumber}` })), unreadPages: [] };
  },
}));
vi.mock("../ocr/hosted-reader.js", () => ({ createHostedOcrReader: () => null }));

const { VisionExtractStage, legacyPageHints } = await import("../stages/vision-extract.js");
const { WorkflowState } = await import("../pipeline/pipeline.js");

/**
 * A scan beside native text (MIXED_SCAN_IMAGE_SIGNAL) is read by the OCR engine in its VM, as scanned pages are, never
 * rasterized on the host for a hosted vision model (owner direction after the real-Modal run, 2026-11-06).
 */
function harness() {
  const rendered: number[] = [];
  const document = { id: "mixed-doc", filename: "mixed.pdf", mimeType: "application/pdf", sourceKey: "mixed.pdf", pageCount: 3 } as never;
  const state = WorkflowState.create({ id: "mixed-run", spentCents: 0, pipeline: { ...defaultPipelineFeatures } } as never, [document]);
  const rasters = {
    sourcePath: async () => "/cache/mixed.pdf",
    renderSelectedPages: async ({ pageNumbers }: { pageNumbers: number[] }) => {
      rendered.push(...pageNumbers);
      return pageNumbers.map((pageNumber) => ({ pageNumber, artifactKey: `p${pageNumber}`, artifactUri: `s3://b/p${pageNumber}`, mimeType: "image/png" }));
    },
  };
  const storage = { downloadToTempFile: async () => join(await mkdtemp(join(process.env.TMPDIR || tmpdir(), "vision-mixed-")), "page.png") };
  const stage = new VisionExtractStage({} as never, storage as never, {} as never, rasters as never);
  const internals = stage as unknown as { callVisionOnImage: (...args: any[]) => Promise<any>; extractVisionPagesFromCache: (...args: any[]) => Promise<any[]> };
  const vision = vi.spyOn(internals, "callVisionOnImage").mockImplementation(async (_state, _doc, _vision, image) =>
    ({ pageNumber: image.pageNumber, inputTokens: 100, outputTokens: 50, latencyMs: 1, text: `vision page ${image.pageNumber}` }));
  const hints = legacyPageHints([
    { pageNumber: 1, textDensityScore: 0, signals: [], ocrDecision: { signals: ["ocr-authorized:garbled-text-layer"] } },
    { pageNumber: 2, textDensityScore: 0.3, signals: [], ocrDecision: { signals: [MIXED_SCAN_IMAGE_SIGNAL] } },
  ]);
  const skips = new Map();
  const read = (pages: number[]) => internals.extractVisionPagesFromCache(state, document, state.run.pipeline.vision, pages, undefined, undefined, undefined, false, { hints, skips });
  return { read, rendered, vision, skips, hints };
}

afterEach(() => { vi.unstubAllEnvs(); ocr.calls = []; ocr.mode = "read"; vi.restoreAllMocks(); });

describe("mixed-scan pages are read by the VM OCR engine", () => {
  it("marks the scan-beside-text pages, and only those", () => {
    expect([...harness().hints.vmOcrPages!]).toEqual([2]);
  });

  it("in vm OCR mode, reads the mixed-scan page in the VM and the rest with vision; nothing of page 2 is rendered on the host", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const h = harness();
    const outputs = await h.read([1, 2]);
    expect(ocr.calls).toEqual([{ pages: [2], kind: "pdf", source: "/cache/mixed.pdf" }]);
    expect(h.rendered).toEqual([1]);
    expect(h.vision).toHaveBeenCalledTimes(1);
    expect(outputs.map((page) => [page.pageNumber, page.text])).toEqual([[1, "vision page 1"], [2, "OCR page 2"]]);
    expect(outputs[1].runtime).toBe("ocr-vm");
    expect(outputs[1]).toMatchObject({ costCents: 0, inputTokens: 0, usageSource: "ocr-ledger" });
  });

  it("a refused VM read skips the page; it is never handed to a hosted model instead", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    ocr.mode = "refuse";
    const h = harness();
    const outputs = await h.read([2]);
    expect(outputs).toEqual([]);
    expect(h.vision).not.toHaveBeenCalled();
    expect(h.rendered).toEqual([]);
    expect(h.skips.get(2)).toMatchObject({ pageNumber: 2, outcome: "failed" });
  });

  it("a boundary that cannot run is retried (the error keeps its identity)", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "vm");
    ocr.mode = "infra";
    const h = harness();
    await expect(h.read([2])).rejects.toMatchObject({ name: "OcrInfrastructureError" });
    expect(h.vision).not.toHaveBeenCalled();
  });

  it("outside vm OCR mode the page keeps its existing reader", async () => {
    vi.stubEnv("DOCSLURP_OCR_MODE", "off");
    const h = harness();
    await h.read([1, 2]);
    expect(ocr.calls).toEqual([]);
    expect(h.vision).toHaveBeenCalledTimes(2);
  });
});
